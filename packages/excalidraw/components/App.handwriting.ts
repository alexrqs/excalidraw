import {
  DEFAULT_VERTICAL_ALIGN,
  getLineHeight,
  TEXT_ALIGN,
  VERTICAL_ALIGN,
} from "@excalidraw/common";

import {
  CaptureUpdateAction,
  getBoundTextElement,
  getCommonBounds,
  isArrowElement,
  isFreeDrawElement,
  redrawTextBoundingBox,
  newElementWith,
  newTextElement,
} from "@excalidraw/element";

import type { ExcalidrawFreeDrawElement } from "@excalidraw/element/types";

import { getLanguage } from "../i18n";

import type App from "./App";

/**
 * Google's handwriting input service — the one behind its handwriting
 * keyboards. Undocumented: it takes the strokes as point lists and answers
 * with ranked guesses for the text.
 */
const HANDWRITING_ENDPOINT =
  "https://inputtools.google.com/request?ime=handwriting&app=mobilesearch&cs=1&oe=UTF-8";

/**
 * Handwriting with the draw-to-shape tool: strokes drawn while Shift is held
 * are inked as freedraw, and once Shift is let go they're read and replaced
 * by text, placed where the writing started.
 */
export class AppHandwriting {
  /** the ink of the writing in progress, in stroke order */
  private strokeIds: ExcalidrawFreeDrawElement["id"][] = [];
  /** Shift was let go mid-stroke: read the writing once that stroke ends */
  private recognizeOnStrokeEnd = false;

  constructor(private app: App) {}

  /** whether a press should ink handwriting rather than sketch a shape */
  shouldWrite = (event: { shiftKey: boolean }) =>
    this.app.state.activeTool.type === "autoshape" && event.shiftKey;

  /** whether the freedraw being drawn is handwriting */
  isWriting = () => this.strokeIds.length > 0;

  addStroke = (element: ExcalidrawFreeDrawElement) => {
    this.strokeIds.push(element.id);
  };

  /** a handwriting stroke ended */
  handleStrokeEnd = () => {
    if (this.recognizeOnStrokeEnd) {
      this.recognizeOnStrokeEnd = false;
      void this.recognize();
    }
  };

  handleShiftUp = () => {
    if (!this.strokeIds.length) {
      return;
    }
    if (this.app.state.newElement?.type === "freedraw") {
      this.recognizeOnStrokeEnd = true;
      return;
    }
    void this.recognize();
  };

  private recognize = async () => {
    const elementsMap = this.app.scene.getNonDeletedElementsMap();
    const strokes = this.strokeIds
      .map((id) => elementsMap.get(id))
      .filter(isFreeDrawElement);
    this.strokeIds = [];
    if (!strokes.length) {
      return;
    }

    const [minX, minY, maxX, maxY] = getCommonBounds(strokes);
    // the service wants each stroke as [xs, ys, times]; the times only order
    // the points, so their count is what matters
    const ink = strokes.map((stroke) => [
      stroke.points.map(([x]) => stroke.x + x - minX),
      stroke.points.map(([, y]) => stroke.y + y - minY),
      stroke.points.map((_, i) => i * 10),
    ]);

    let text: string | undefined;
    try {
      const response = await fetch(HANDWRITING_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          options: "enable_pre_space",
          requests: [
            {
              writing_guide: {
                writing_area_width: Math.max(1, maxX - minX),
                writing_area_height: Math.max(1, maxY - minY),
              },
              ink,
              language: getLanguage().code.split("-")[0],
            },
          ],
        }),
      });
      // ["SUCCESS", [[id, [best guess, …], …]]]
      const result = await response.json();
      text = result?.[0] === "SUCCESS" ? result[1]?.[0]?.[1]?.[0] : undefined;
    } catch (error) {
      console.error("Handwriting recognition failed", error);
    }

    if (!text?.trim()) {
      // unreadable or offline: the ink stays, so nothing written is lost
      this.app.setState({
        errorMessage: "Couldn't read the handwriting — the ink was kept.",
      });
      return;
    }

    // written inside a shape without a label: it becomes the shape's label,
    // centered in it, as if typed into it with a double-click
    const containerAtInk = this.app.text.getTextBindableContainerAtPosition(
      (minX + maxX) / 2,
      (minY + maxY) / 2,
    );
    const container =
      containerAtInk &&
      !isArrowElement(containerAtInk) &&
      !getBoundTextElement(
        containerAtInk,
        this.app.scene.getNonDeletedElementsMap(),
      )
        ? containerAtInk
        : null;

    // styled exactly as the text tool would type it
    const { state } = this.app;
    const typed = newTextElement({
      x: minX,
      y: minY,
      text: text.trim(),
      fontSize: state.currentItemFontSize,
      fontFamily: state.currentItemFontFamily,
      lineHeight: getLineHeight(state.currentItemFontFamily),
      textAlign: container ? TEXT_ALIGN.CENTER : state.currentItemTextAlign,
      verticalAlign: container ? VERTICAL_ALIGN.MIDDLE : DEFAULT_VERTICAL_ALIGN,
      containerId: container?.id ?? null,
      groupIds: container?.groupIds ?? [],
      angle: container?.angle,
      strokeColor: state.currentItemStrokeColor,
      backgroundColor: state.currentItemBackgroundColor,
      fillStyle: state.currentItemFillStyle,
      strokeWidth: this.app.getCurrentItemStrokeWidth("text"),
      strokeStyle: state.currentItemStrokeStyle,
      roughness: state.currentItemRoughness,
      opacity: state.currentItemOpacity,
      frameId:
        this.app.getTopLayerFrameAtSceneCoords({ x: minX, y: minY })?.id ??
        null,
      renderEnvironment: this.app.renderEnvironment,
    });
    // where the writing was: from its left edge, centered on it vertically
    const textElement = newElementWith(typed, {
      y: (minY + maxY) / 2 - typed.height / 2,
    });

    // the ink may have been erased or undone while it was being read
    const strokeIds = new Set(strokes.map((stroke) => stroke.id));
    const elements = this.app.scene.getElementsIncludingDeleted();
    if (
      !elements.some(
        (element) => strokeIds.has(element.id) && !element.isDeleted,
      )
    ) {
      return;
    }

    this.app.updateScene({
      elements: elements.flatMap((element) =>
        strokeIds.has(element.id)
          ? // the text goes in place of the writing's first stroke, or right
            // above its container so it's drawn on it
            [
              newElementWith(element, { isDeleted: true }),
              ...(!container && element.id === strokes[0].id
                ? [textElement]
                : []),
            ]
          : element.id === container?.id
          ? [
              newElementWith(element, {
                boundElements: [
                  ...(element.boundElements ?? []),
                  { type: "text", id: textElement.id },
                ],
              }),
              textElement,
            ]
          : [element],
      ),
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });

    if (container) {
      // lays the label out in its container: centered, wrapped to fit
      const label = this.app.scene.getElement(textElement.id);
      const latestContainer = this.app.scene.getElement(container.id);
      if (label?.type === "text" && latestContainer) {
        redrawTextBoundingBox(
          label,
          latestContainer,
          this.app.scene,
          this.app.renderEnvironment,
        );
      }
    }
  };
}
