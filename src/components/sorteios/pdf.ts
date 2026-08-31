import { jsPDF } from "jspdf";
import {
  INSTAGRAM_HANDLE,
  INSTAGRAM_POST_ID,
  PRIZE_NAME,
  type ParticipationEntry,
  type SorteioSession,
} from "./types";

const GREEN: [number, number, number] = [16, 185, 129];
const DARK: [number, number, number] = [15, 23, 42];
const MUTED: [number, number, number] = [100, 116, 139];
const BORDER: [number, number, number] = [226, 232, 240];

function formatDateTime(iso: string | null) {
  if (!iso) return "-";
  return new Date(iso).toLocaleString("pt-BR");
}

export function buildComprovantePdf(session: SorteioSession) {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const marginX = 48;
  const pageWidth = doc.internal.pageSize.getWidth();
  const contentWidth = pageWidth - marginX * 2;
  let y = 56;

  doc.setFillColor(...GREEN);
  doc.rect(0, 0, pageWidth, 8, "F");

  doc.setFont("helvetica", "bold");
  doc.setFontSize(20);
  doc.setTextColor(...DARK);
  doc.text("MILITRIN", marginX, y);
  y += 20;

  doc.setFontSize(12);
  doc.setTextColor(...GREEN);
  doc.text("SORTEIO OFICIAL", marginX, y);
  y += 28;

  doc.setDrawColor(...BORDER);
  doc.line(marginX, y, pageWidth - marginX, y);
  y += 24;

  const field = (label: string, value: string) => {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(...MUTED);
    doc.text(label.toUpperCase(), marginX, y);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.setTextColor(...DARK);
    const lines = doc.splitTextToSize(value || "-", contentWidth);
    doc.text(lines, marginX, y + 14);
    y += 14 + lines.length * 13 + 10;
  };

  field("Prêmio", PRIZE_NAME);
  field("Post oficial", INSTAGRAM_POST_ID);
  field("Identificador do sorteio", session.id);
  field("Data/hora da importação", formatDateTime(session.importedAt));
  field("Data/hora do sorteio", formatDateTime(session.currentDrawAt));
  field("Quantidade total de comentários", String(session.entries.length));
  field("Quantidade de participantes únicos", String(new Set(session.entries.map((e) => e.username.toLowerCase())).size));
  field("Quantidade de chances", String(session.entries.length));

  y += 8;
  doc.setDrawColor(...BORDER);
  doc.line(marginX, y, pageWidth - marginX, y);
  y += 24;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(13);
  doc.setTextColor(...DARK);
  doc.text("Ganhador", marginX, y);
  y += 20;

  const winner: ParticipationEntry | undefined = session.entries.find(
    (e) => e.commentId === session.confirmedWinner?.commentId,
  );

  if (winner) {
    field("Usuário", `@${winner.username}`);
    field("Comentário vencedor", winner.comment);
    field("ID do comentário", winner.commentId);
    field("Link do comentário", winner.commentUrl || "-");
  } else {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.setTextColor(...MUTED);
    doc.text("Nenhum ganhador confirmado ainda.", marginX, y);
    y += 18;
  }

  y += 4;
  doc.setFillColor(...GREEN);
  doc.roundedRect(marginX, y, 180, 26, 6, 6, "F");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.setTextColor(255, 255, 255);
  doc.text(winner ? "GANHADOR CONFIRMADO" : "AGUARDANDO CONFIRMAÇÃO", marginX + 10, y + 17);
  y += 46;

  if (session.disqualifications.length > 0) {
    doc.setDrawColor(...BORDER);
    doc.line(marginX, y, pageWidth - marginX, y);
    y += 24;

    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.setTextColor(...DARK);
    doc.text("Participantes desclassificados anteriormente", marginX, y);
    y += 18;

    session.disqualifications.forEach((d) => {
      doc.setFont("helvetica", "bold");
      doc.setFontSize(10);
      doc.setTextColor(...DARK);
      doc.text(`@${d.username}`, marginX, y);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(9);
      doc.setTextColor(...MUTED);
      const detail = `Motivo: ${d.reasonLabel}${d.otherDetail ? ` — ${d.otherDetail}` : ""} · ${formatDateTime(d.disqualifiedAt)}`;
      const lines = doc.splitTextToSize(detail, contentWidth);
      doc.text(lines, marginX, y + 12);
      y += 12 + lines.length * 11 + 8;
    });
  }

  const pageHeight = doc.internal.pageSize.getHeight();
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.setTextColor(...MUTED);
  doc.text(`Comprovante gerado em ${new Date().toLocaleString("pt-BR")} · ${INSTAGRAM_HANDLE}`, marginX, pageHeight - 30);

  return doc;
}

export function downloadComprovantePdf(session: SorteioSession) {
  const doc = buildComprovantePdf(session);
  doc.save(`comprovante-${session.id}.pdf`);
}
