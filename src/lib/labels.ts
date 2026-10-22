/**
 * Screen-label layout: labels are placed in priority order and each one
 * tries a few spots around its anchor before giving up, so names never
 * overlap each other, the viewport edge or the chrome.
 */

export interface LabelInput {
  key: string;
  /** Anchor on screen (px). */
  x: number;
  y: number;
  /** Radius of the anchor's disc (px): the label keeps clear of it. */
  px: number;
  text: string;
  /** Higher wins a contested spot. */
  priority: number;
}

export interface LabelPlacement {
  left: number;
  top: number;
  hidden: boolean;
}

const LINE = 18;
/** Average advance of the 11 px label type, plus the dot and padding. */
const CHAR = 6.4;
const PAD = 22;

export function layoutLabels(labels: LabelInput[], width: number, height: number, reserved: [number, number, number, number][] = []): Map<string, LabelPlacement> {
  const boxes: [number, number, number, number][] = [...reserved];
  const out = new Map<string, LabelPlacement>();
  const sorted = [...labels].sort((a, b) => b.priority - a.priority);
  for (const l of sorted) {
    const w = PAD + l.text.length * CHAR;
    const off = Math.max(8, l.px + 6);
    // Right of the anchor, then left, below and above; the side spots may slide vertically and the
    // stacked ones horizontally to stay on screen.
    const cy = Math.min(height - 4 - LINE, Math.max(4, l.y - LINE / 2));
    const cx = Math.min(width - 4 - w, Math.max(4, l.x - w / 2));
    const spots: [number, number][] = [
      [l.x + off, cy],
      [l.x - off - w, cy],
      [cx, l.y + off + 2],
      [cx, l.y - off - LINE - 2],
    ];
    let placed: [number, number] | null = null;
    for (const [cx, cy] of spots) {
      if (cx < 4 || cy < 4 || cx + w > width - 4 || cy + LINE > height - 4) continue;
      if (boxes.some((b) => cx < b[2] && cx + w > b[0] && cy < b[3] && cy + LINE > b[1])) continue;
      placed = [cx, cy];
      break;
    }
    if (placed) {
      boxes.push([placed[0], placed[1], placed[0] + w, placed[1] + LINE]);
      out.set(l.key, { left: placed[0], top: placed[1], hidden: false });
    } else out.set(l.key, { left: spots[0][0], top: spots[0][1], hidden: true });
  }
  return out;
}
