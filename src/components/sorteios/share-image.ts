import { INSTAGRAM_HANDLE, PRIZE_NAME } from "./types";

const WIDTH = 1080;
const HEIGHT = 1920;

export async function buildShareImageBlob(username: string): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Não foi possível gerar a imagem.");

  const bg = ctx.createLinearGradient(0, 0, WIDTH, HEIGHT);
  bg.addColorStop(0, "#020617");
  bg.addColorStop(1, "#0f172a");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  const glow = ctx.createRadialGradient(WIDTH / 2, HEIGHT * 0.35, 80, WIDTH / 2, HEIGHT * 0.35, 700);
  glow.addColorStop(0, "rgba(52, 211, 153, 0.35)");
  glow.addColorStop(1, "rgba(52, 211, 153, 0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  ctx.strokeStyle = "rgba(52, 211, 153, 0.35)";
  ctx.lineWidth = 4;
  ctx.strokeRect(48, 48, WIDTH - 96, HEIGHT - 96);

  ctx.textAlign = "center";

  ctx.fillStyle = "#34d399";
  ctx.font = "600 34px Arial";
  ctx.fillText("MILITRIN · SORTEIO OFICIAL", WIDTH / 2, 300);

  ctx.fillStyle = "#f8fafc";
  ctx.font = "800 84px Arial";
  wrapCenteredText(ctx, "TEMOS UM GANHADOR! 🍀", WIDTH / 2, 460, WIDTH - 160, 94);

  ctx.fillStyle = "#cbd5f5";
  ctx.font = "500 46px Arial";
  ctx.fillText(PRIZE_NAME, WIDTH / 2, 760);

  ctx.fillStyle = "#020617";
  const chipWidth = Math.min(WIDTH - 160, Math.max(500, username.length * 44 + 140));
  const chipHeight = 160;
  const chipY = 900;
  roundRect(ctx, WIDTH / 2 - chipWidth / 2, chipY, chipWidth, chipHeight, 40);
  ctx.fillStyle = "#34d399";
  ctx.fill();

  ctx.fillStyle = "#022c22";
  ctx.font = "800 68px Arial";
  ctx.fillText(`@${username}`, WIDTH / 2, chipY + chipHeight / 2 + 24);

  ctx.fillStyle = "#f8fafc";
  ctx.font = "600 52px Arial";
  ctx.fillText("Parabéns! 🎉", WIDTH / 2, chipY + chipHeight + 140);

  ctx.fillStyle = "#94a3b8";
  ctx.font = "500 38px Arial";
  ctx.fillText(INSTAGRAM_HANDLE, WIDTH / 2, HEIGHT - 140);

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("Falha ao gerar imagem."));
    }, "image/png");
  });
}

function wrapCenteredText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, maxWidth: number, lineHeight: number) {
  const words = text.split(" ");
  let line = "";
  const currentY = y;
  const lines: string[] = [];

  for (const word of words) {
    const testLine = line ? `${line} ${word}` : word;
    if (ctx.measureText(testLine).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = testLine;
    }
  }
  if (line) lines.push(line);

  lines.forEach((l, i) => ctx.fillText(l, x, currentY + i * lineHeight));
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + width, y, x + width, y + height, radius);
  ctx.arcTo(x + width, y + height, x, y + height, radius);
  ctx.arcTo(x, y + height, x, y, radius);
  ctx.arcTo(x, y, x + width, y, radius);
  ctx.closePath();
}

export async function downloadShareImage(username: string, sorteioId: string) {
  const blob = await buildShareImageBlob(username);
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `sorteio-militrin-${sorteioId}.png`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
