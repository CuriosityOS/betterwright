import type { ExpectedInput } from "../types/electron.js";
import { isNumber, isString, type UntrustedValue } from "./untrusted-value.js";

export function betterwrightExpectedInputs(
  method: string,
  params: Record<string, UntrustedValue>,
): ExpectedInput[] {
  if (
    method === "Input.dispatchKeyEvent" &&
    ["keyDown", "rawKeyDown"].includes(String(params.type)) &&
    isString(params.key)
  ) {
    const modifiers = isNumber(params.modifiers) ? params.modifiers : 0;
    return [
      {
        kind: "key",
        key: params.key,
        alt: Boolean(modifiers & 1),
        control: Boolean(modifiers & 2),
        meta: Boolean(modifiers & 4),
        shift: Boolean(modifiers & 8),
      },
    ];
  }
  if (
    method !== "Input.dispatchMouseEvent" ||
    !isNumber(params.x) ||
    !isNumber(params.y)
  )
    return [];
  if (params.type !== "mousePressed" && params.type !== "mouseWheel") return [];
  const button: "left" | "right" | "middle" | undefined =
    params.button === "left" || params.button === "right" || params.button === "middle"
      ? params.button
      : undefined;
  const point = {
    x: params.x,
    y: params.y,
    button,
  };
  return [
    { kind: "mouse", type: params.type === "mouseWheel" ? "mouseWheel" : "mouseDown", ...point },
    ...(button === "right" && params.type === "mousePressed"
      ? [{ kind: "mouse" as const, type: "contextMenu" as const, ...point }]
      : []),
  ];
}
