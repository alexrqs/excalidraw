import {
  applyDarkModeFilter,
  COLOR_WHITE,
  FRAME_STYLE,
  THEME,
  throttleRAF,
} from "@excalidraw/common";
import { isElementLink } from "@excalidraw/element";
import { createPlaceholderEmbeddableLabel } from "@excalidraw/element";
import { getBoundTextElement } from "@excalidraw/element";
import {
  isEmbeddableElement,
  isIframeLikeElement,
  isTextElement,
} from "@excalidraw/element";
import {
  elementOverlapsWithFrame,
  getTargetFrame,
  shouldApplyFrameClip,
} from "@excalidraw/element";

import {
  getRenderElementWithPositionOverride,
  resolveElementRenderState,
  renderElement,
  withSavedContext,
} from "@excalidraw/element";

import { getRenderEnvironment } from "@excalidraw/element/renderEnvironment";

import { getElementAbsoluteCoords } from "@excalidraw/element";

import type { RenderEnvironment } from "@excalidraw/element/renderEnvironment";

import type { ElementRenderState } from "@excalidraw/element";

import type {
  ElementsMap,
  ExcalidrawElement,
  ExcalidrawFrameLikeElement,
  NonDeletedExcalidrawElement,
} from "@excalidraw/element/types";

import {
  getExternalLinkImg,
  getElementLinkImg,
  getLinkHandleFromCoords,
} from "../components/hyperlink/helpers";

import {
  bootstrapCanvas,
  getNormalizedCanvasDimensions,
  snapScrollToDevicePixels,
} from "./helpers";

import type {
  StaticCanvasRenderConfig,
  StaticSceneRenderConfig,
} from "../scene/types";
import type { StaticCanvasAppState, Zoom } from "../types";

/**
 * A render failure is per-element on purpose, on export too: one bad element
 * must not blank the canvas or fail the export, the rest of the scene
 * survives it.
 */
const logElementRenderError = (
  error: unknown,
  element: NonDeletedExcalidrawElement,
) => {
  console.error(
    error,
    element.id,
    element.x,
    element.y,
    element.width,
    element.height,
  );
};

const GridDotColor = {
  [THEME.LIGHT]: {
    bold: "#c2c2c2",
    regular: "#d6d6d6",
  },
  [THEME.DARK]: {
    bold: applyDarkModeFilter("#c2c2c2"),
    regular: applyDarkModeFilter("#d6d6d6"),
  },
} as const;

/** dot radii in CSS pixels, the same at any zoom */
const GRID_DOT_RADIUS = 1;
const GRID_BOLD_DOT_RADIUS = 1.5;

/** the grid, drawn as a dot at each cell corner */
const strokeGrid = (
  context: CanvasRenderingContext2D,
  /** grid cell pixel size */
  gridSize: number,
  /** every this many cells a corner gets a bolder dot; 1 disables them */
  gridStep: number,
  scrollX: number,
  scrollY: number,
  zoom: Zoom,
  theme: StaticCanvasRenderConfig["theme"],
  width: number,
  height: number,
) => {
  // zoomed far out, only bold dots are drawn: the rest would be a haze
  const regularVisible = gridSize * zoom.value >= 10;
  if (!regularVisible && gridStep <= 1) {
    return;
  }

  const offsetX = (scrollX % gridSize) - gridSize;
  const offsetY = (scrollY % gridSize) - gridSize;
  const isBoldLine = (position: number, scroll: number) =>
    gridStep > 1 && Math.round(position - scroll) % (gridStep * gridSize) === 0;

  const radius = GRID_DOT_RADIUS / zoom.value;
  const boldRadius = GRID_BOLD_DOT_RADIUS / zoom.value;
  const regularDots = new Path2D();
  const boldDots = new Path2D();

  for (let x = offsetX; x < offsetX + width + gridSize * 2; x += gridSize) {
    const isBoldX = isBoldLine(x, scrollX);
    for (let y = offsetY; y < offsetY + height + gridSize * 2; y += gridSize) {
      const isBold = isBoldX && isBoldLine(y, scrollY);
      if (isBold) {
        boldDots.moveTo(x + boldRadius, y);
        boldDots.arc(x, y, boldRadius, 0, Math.PI * 2);
      } else if (regularVisible) {
        regularDots.moveTo(x + radius, y);
        regularDots.arc(x, y, radius, 0, Math.PI * 2);
      }
    }
  }

  context.save();
  context.fillStyle = GridDotColor[theme].regular;
  context.fill(regularDots);
  context.fillStyle = GridDotColor[theme].bold;
  context.fill(boldDots);
  context.restore();
};

export const frameClip = (
  frame: ExcalidrawFrameLikeElement,
  context: CanvasRenderingContext2D,
  renderConfig: StaticCanvasRenderConfig,
  appState: StaticCanvasAppState,
) => {
  context.translate(frame.x + appState.scrollX, frame.y + appState.scrollY);
  context.beginPath();
  if (context.roundRect) {
    context.roundRect(
      0,
      0,
      frame.width,
      frame.height,
      FRAME_STYLE.radius / appState.zoom.value,
    );
  } else {
    context.rect(0, 0, frame.width, frame.height);
  }
  context.clip();
  context.translate(
    -(frame.x + appState.scrollX),
    -(frame.y + appState.scrollY),
  );
};

type LinkIconCanvasCacheType = "regularLink" | "elementLink";

const linkIconCanvasCache = new WeakMap<
  RenderEnvironment,
  Map<string, HTMLCanvasElement>
>();
const LINK_ICON_CACHE_MAX_ENTRIES = 8;

const getLinkIconCacheKey = (
  type: LinkIconCanvasCacheType,
  canvasWidth: number,
  canvasHeight: number,
  backgroundColor: string,
) => `${type}:${canvasWidth}x${canvasHeight}:${backgroundColor}`;

const renderLinkIcon = (
  element: NonDeletedExcalidrawElement,
  context: CanvasRenderingContext2D,
  appState: StaticCanvasAppState,
  elementsMap: ElementsMap,
  renderState: ElementRenderState,
  /** backing-store scale, see StaticCanvasRenderConfig["scale"] */
  scale: number,
  renderEnvironment: RenderEnvironment,
) => {
  if (element.link && !appState.selectedElementIds[element.id]) {
    const [x1, y1, x2, y2] = getElementAbsoluteCoords(element, elementsMap);
    const [x, y, width, height] = getLinkHandleFromCoords(
      [
        x1 + renderState.offset.x,
        y1 + renderState.offset.y,
        x2 + renderState.offset.x,
        y2 + renderState.offset.y,
      ],
      element.angle,
      appState,
    );
    const centerX = x + width / 2;
    const centerY = y + height / 2;
    context.save();
    context.translate(appState.scrollX + centerX, appState.scrollY + centerY);
    context.rotate(element.angle);

    const canvasKey: LinkIconCanvasCacheType = isElementLink(element.link)
      ? "elementLink"
      : "regularLink";

    const linkImg =
      canvasKey === "elementLink"
        ? getElementLinkImg(renderEnvironment)
        : getExternalLinkImg(renderEnvironment);

    if (linkImg.status !== "decoded") {
      context.restore();
      return;
    }

    const canvasWidth = Math.max(
      1,
      Math.floor(width * scale * appState.zoom.value),
    );
    const canvasHeight = Math.max(
      1,
      Math.floor(height * scale * appState.zoom.value),
    );
    const backgroundColor = appState.viewBackgroundColor || COLOR_WHITE;
    const cacheKey = getLinkIconCacheKey(
      canvasKey,
      canvasWidth,
      canvasHeight,
      backgroundColor,
    );

    let cache = linkIconCanvasCache.get(renderEnvironment);
    if (!cache) {
      cache = new Map();
      linkIconCanvasCache.set(renderEnvironment, cache);
    }

    let linkCanvas = cache.get(cacheKey);

    if (linkCanvas) {
      cache.delete(cacheKey);
      cache.set(cacheKey, linkCanvas);
    } else {
      linkCanvas = renderEnvironment.createCanvas();
      linkCanvas.width = canvasWidth;
      linkCanvas.height = canvasHeight;
      cache.set(cacheKey, linkCanvas);
      if (cache.size > LINK_ICON_CACHE_MAX_ENTRIES) {
        const lruKey = cache.keys().next().value;
        if (lruKey !== undefined) {
          cache.delete(lruKey);
        }
      }

      const linkCanvasCacheContext = linkCanvas.getContext("2d")!;
      linkCanvasCacheContext.scale(
        scale * appState.zoom.value,
        scale * appState.zoom.value,
      );

      // Seed a sane default so a corrupted color (silently rejected by the
      // canvas) falls back to white instead of a stale fillStyle.
      linkCanvasCacheContext.fillStyle = COLOR_WHITE;
      linkCanvasCacheContext.fillStyle = backgroundColor;

      linkCanvasCacheContext.fillRect(0, 0, width, height);

      linkCanvasCacheContext.drawImage(linkImg.img, 0, 0, width, height);

      linkCanvasCacheContext.restore();
    }
    context.globalAlpha = renderState.opacity;
    context.drawImage(linkCanvas, x - centerX, y - centerY, width, height);
    context.restore();
  }
};
const _renderStaticScene = ({
  canvas,
  rc,
  elementsMap,
  allElementsMap,
  visibleElements,
  scale,
  appState: unsnappedAppState,
  renderConfig,
}: StaticSceneRenderConfig) => {
  if (canvas === null) {
    return;
  }

  const { renderGrid = true, isExporting } = renderConfig;
  // export draws vectors, not cached bitmaps — nothing to keep on the grid
  const appState = isExporting
    ? unsnappedAppState
    : snapScrollToDevicePixels(unsnappedAppState, scale);

  const [normalizedWidth, normalizedHeight] = getNormalizedCanvasDimensions(
    canvas,
    scale,
  );

  const context = bootstrapCanvas({
    canvas,
    scale,
    normalizedWidth,
    normalizedHeight,
    theme: appState.theme,
    isExporting,
    viewBackgroundColor: appState.viewBackgroundColor,
  });

  // Apply zoom
  context.scale(appState.zoom.value, appState.zoom.value);

  // Grid
  if (renderGrid) {
    strokeGrid(
      context,
      appState.gridSize,
      appState.gridStep,
      appState.scrollX,
      appState.scrollY,
      appState.zoom,
      renderConfig.theme,
      normalizedWidth / appState.zoom.value,
      normalizedHeight / appState.zoom.value,
    );
  }

  if (renderConfig.clipToFrame) {
    const frame = renderConfig.clipToFrame;
    context.beginPath();
    context.rect(
      frame.x + appState.scrollX,
      frame.y + appState.scrollY,
      frame.width,
      frame.height,
    );
    context.clip();
  }

  const groupsToBeAddedToFrame = new Set<string>();

  visibleElements.forEach((element) => {
    if (
      element.groupIds.length > 0 &&
      appState.frameToHighlight &&
      appState.selectedElementIds[element.id] &&
      (elementOverlapsWithFrame(
        element,
        appState.frameToHighlight,
        elementsMap,
      ) ||
        element.groupIds.find((groupId) => groupsToBeAddedToFrame.has(groupId)))
    ) {
      element.groupIds.forEach((groupId) =>
        groupsToBeAddedToFrame.add(groupId),
      );
    }
  });

  const inFrameGroupsMap = new Map<string, boolean>();

  const getRenderState = (element: ExcalidrawElement) =>
    resolveElementRenderState(
      element,
      elementsMap,
      renderConfig,
      allElementsMap,
    );

  const clipElementToFrame = (
    element: NonDeletedExcalidrawElement,
    renderState: ElementRenderState,
  ) => {
    if (
      !(element.frameId || appState.frameToHighlight?.id) ||
      !appState.frameRendering.enabled ||
      !appState.frameRendering.clip
    ) {
      return;
    }
    const targetFrame = getTargetFrame(element, elementsMap, appState);
    if (!targetFrame) {
      return;
    }
    const frameState = getRenderState(targetFrame);
    const frame = getRenderElementWithPositionOverride(
      targetFrame,
      frameState.offset,
    );
    const isTranslated = (state: ElementRenderState) =>
      state.offset.x !== 0 || state.offset.y !== 0;
    if (
      (element.frameId === frame.id &&
        (isTranslated(renderState) || isTranslated(frameState))) ||
      shouldApplyFrameClip(
        getRenderElementWithPositionOverride(element, renderState.offset),
        frame,
        appState,
        elementsMap,
        inFrameGroupsMap,
      )
    ) {
      frameClip(frame, context, renderConfig, appState);
    }
  };

  // Paint visible elements
  visibleElements
    .filter((el) => !isIframeLikeElement(el))
    .forEach((element) => {
      try {
        if (
          isTextElement(element) &&
          element.containerId &&
          elementsMap.has(element.containerId)
        ) {
          // will be rendered with the container
          return;
        }

        const boundTextElement = getBoundTextElement(element, elementsMap);

        const renderState = getRenderState(element);
        withSavedContext(context, () => {
          clipElementToFrame(element, renderState);
          renderElement(
            element,
            elementsMap,
            allElementsMap,
            rc,
            context,
            renderConfig,
            appState,
            renderState,
          );

          if (boundTextElement) {
            renderElement(
              boundTextElement,
              elementsMap,
              allElementsMap,
              rc,
              context,
              renderConfig,
              appState,
            );
          }
        });

        if (!isExporting && renderConfig.renderLinks !== false) {
          renderLinkIcon(
            element,
            context,
            appState,
            elementsMap,
            renderState,
            scale,
            getRenderEnvironment(renderConfig.renderEnvironment),
          );
        }
      } catch (error: any) {
        logElementRenderError(error, element);
      }
    });

  // render embeddables on top
  visibleElements
    .filter((el) => isIframeLikeElement(el))
    .forEach((element) => {
      try {
        const renderState = getRenderState(element);
        withSavedContext(context, () => {
          clipElementToFrame(element, renderState);
          renderElement(
            element,
            elementsMap,
            allElementsMap,
            rc,
            context,
            renderConfig,
            appState,
            renderState,
          );

          if (
            isIframeLikeElement(element) &&
            (isExporting ||
              (isEmbeddableElement(element) &&
                renderConfig.embedsValidationStatus.get(element.id) !==
                  true)) &&
            element.width &&
            element.height
          ) {
            const label = {
              ...createPlaceholderEmbeddableLabel(
                element,
                renderConfig.renderEnvironment,
              ),
              // Synthetic visual: resolve overrides and frame opacity through
              // its owner, without creating another animation target.
              id: element.id,
              frameId: element.frameId,
            };
            renderElement(
              label,
              elementsMap,
              allElementsMap,
              rc,
              context,
              renderConfig,
              appState,
            );
          }
          if (!isExporting && renderConfig.renderLinks !== false) {
            renderLinkIcon(
              element,
              context,
              appState,
              elementsMap,
              renderState,
              scale,
              getRenderEnvironment(renderConfig.renderEnvironment),
            );
          }
        });
      } catch (error: any) {
        logElementRenderError(error, element);
      }
    });

  // render pending nodes for flowcharts
  renderConfig.pendingFlowchartNodes?.forEach((element) => {
    try {
      renderElement(
        element,
        elementsMap,
        allElementsMap,
        rc,
        context,
        renderConfig,
        appState,
      );
    } catch (error) {
      logElementRenderError(error, element);
    }
  });
};

type StaticSceneThrottle = ReturnType<typeof throttleRAF>;

const staticSceneThrottles = new WeakMap<
  HTMLCanvasElement,
  { throttle: StaticSceneThrottle; ownerWindow: Window }
>();

const getStaticSceneThrottle = (canvas: HTMLCanvasElement) => {
  const ownerWindow = canvas.ownerDocument.defaultView ?? window;
  let entry = staticSceneThrottles.get(canvas);
  // the owner window is captured when the throttle is built, so a canvas
  // adopted into another document (moved rather than remounted) would keep
  // scheduling on the old window's rAF -- which never fires once that window
  // is closed. rebuild whenever the owner window no longer matches.
  if (entry && entry.ownerWindow !== ownerWindow) {
    entry.throttle.cancel();
    entry = undefined;
  }
  if (!entry) {
    entry = {
      throttle: throttleRAF((config: StaticSceneRenderConfig) => {
        _renderStaticScene(config);
      }, ownerWindow),
      ownerWindow,
    };
    staticSceneThrottles.set(canvas, entry);
  }
  return entry.throttle;
};

/**
 * Throttled to animation framerate, one throttle per canvas. A shared
 * throttle drops all but the last caller's pending frame when multiple
 * editors render in the same frame, and a module-realm scheduler would run
 * popout renders on the main window's rAF, which freezes while that window
 * is hidden.
 */
export const renderStaticSceneThrottled = (config: StaticSceneRenderConfig) => {
  getStaticSceneThrottle(config.canvas)(config);
};

/** Drops the canvas' pending frame; the throttle itself is dropped with the
 * canvas. */
export const cancelStaticSceneThrottle = (canvas: HTMLCanvasElement) => {
  staticSceneThrottles.get(canvas)?.throttle.cancel();
};

/**
 * Static scene is the non-ui canvas where we render elements.
 */
export const renderStaticScene = (
  renderConfig: StaticSceneRenderConfig,
  throttle?: boolean,
) => {
  if (throttle) {
    renderStaticSceneThrottled(renderConfig);
    return;
  }

  _renderStaticScene(renderConfig);
};
