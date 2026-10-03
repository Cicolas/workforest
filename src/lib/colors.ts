import { styleText } from "node:util";

function paint(
  format: Parameters<typeof styleText>[0],
  text: string,
  stream = process.stdout,
): string {
  const forceColor = process.env.FORCE_COLOR;
  if (
    forceColor === "0" ||
    (!forceColor && (process.env.NO_COLOR || process.env.NODE_DISABLE_COLORS))
  ) {
    return text;
  }

  return styleText(format, text, { stream });
}

export function supportsColor(stream = process.stdout): boolean {
  return paint("bold", "color", stream) !== "color";
}

export const colors = {
  heading: (text: string, stream = process.stdout) =>
    paint("bold", text, stream),
  success: (text: string, stream = process.stdout) =>
    paint("green", text, stream),
  warning: (text: string, stream = process.stdout) =>
    paint("yellow", text, stream),
  muted: (text: string, stream = process.stdout) => paint("dim", text, stream),
  error: (text: string, stream = process.stderr) => paint("red", text, stream),
};
