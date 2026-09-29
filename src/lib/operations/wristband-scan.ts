import { parseTicketDisplayCode } from "../display-reference";
import { parseTokenCandidate } from "../tickets/parse-token-candidate";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const WRISTBAND_QR_UNRECOGNIZED = "QR não reconhecido como pulseira.";

/** Normaliza o QR lido e rejeita identificadores de ingresso (UUID/token/#codigo). */
export function parseWristbandScan(rawValue: string): { ok: true; code: string } | { ok: false; message: string } {
  const code = parseTokenCandidate(rawValue);
  if (!code) return { ok: false, message: WRISTBAND_QR_UNRECOGNIZED };
  if (UUID_PATTERN.test(code)) return { ok: false, message: WRISTBAND_QR_UNRECOGNIZED };
  if (parseTicketDisplayCode(code)) return { ok: false, message: WRISTBAND_QR_UNRECOGNIZED };
  return { ok: true, code };
}
