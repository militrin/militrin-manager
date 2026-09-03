import QRCode from "qrcode";

/**
 * Gera um data URL PNG localmente. O conteudo (token operacional, PIX, etc.)
 * nunca e enviado a um servico terceiro.
 */
export async function generateQrDataUrl(value: string, size = 320): Promise<string> {
  const payload = String(value ?? "").trim();
  if (!payload) {
    throw new Error("QR vazio.");
  }
  return QRCode.toDataURL(payload, {
    width: size,
    margin: 1,
    errorCorrectionLevel: "M",
    color: { dark: "#0f172a", light: "#ffffff" },
  });
}

export async function generateQrPngBase64(value: string, size = 512): Promise<string> {
  const dataUrl = await generateQrDataUrl(value, size);
  const comma = dataUrl.indexOf(",");
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}
