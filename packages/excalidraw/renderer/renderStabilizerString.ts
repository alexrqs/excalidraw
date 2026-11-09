import { THEME } from "@excalidraw/common";

import type { InteractiveCanvasAppState } from "../types";

const STRING_COLOR_LIGHT = "#e64980";
const STRING_COLOR_DARK = "#f783ac";
const MARKER_COLOR_LIGHT = "#1971c2";
const MARKER_COLOR_DARK = "#4dabf7";
// sizes in screen px, kept constant at any zoom
const STRING_WIDTH = 2;
const MARKER_WIDTH = 2;
const CROSS_SIZE = 7;
const POINTER_RADIUS = 6;

/**
 * The freedraw stabilizer's pulled string: a cross at the brush, where the
 * stroke is being laid down, the string, and a ring at the pointer pulling it.
 */
export const renderStabilizerString = (
  context: CanvasRenderingContext2D,
  appState: InteractiveCanvasAppState,
) => {
  const string = appState.freedrawStabilizerString;
  if (!string) {
    return;
  }

  const { brush, pointer } = string;
  const zoom = appState.zoom.value;
  const isLight = appState.theme === THEME.LIGHT;

  context.save();
  context.translate(appState.scrollX, appState.scrollY);
  context.lineCap = "round";

  context.strokeStyle = isLight ? STRING_COLOR_LIGHT : STRING_COLOR_DARK;
  context.lineWidth = STRING_WIDTH / zoom;
  context.beginPath();
  context.moveTo(brush.x, brush.y);
  context.lineTo(pointer.x, pointer.y);
  context.stroke();

  context.strokeStyle = isLight ? MARKER_COLOR_LIGHT : MARKER_COLOR_DARK;
  context.lineWidth = MARKER_WIDTH / zoom;

  const cross = CROSS_SIZE / zoom;
  context.beginPath();
  context.moveTo(brush.x - cross, brush.y);
  context.lineTo(brush.x + cross, brush.y);
  context.moveTo(brush.x, brush.y - cross);
  context.lineTo(brush.x, brush.y + cross);
  context.stroke();

  context.beginPath();
  context.arc(pointer.x, pointer.y, POINTER_RADIUS / zoom, 0, Math.PI * 2);
  context.stroke();

  context.restore();
};
