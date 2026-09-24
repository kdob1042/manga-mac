// Map familiar edit requests to typed scene or image operations.
export function editRoute(instruction) {
  if (/台詞.*(変|直|書|言い換)|セリフ.*(変|直|書|言い換)/.test(instruction)) return { kind: 'readonly' };
  if (/吹き出し|文字配置|組版/.test(instruction)) return { kind: 'layout' };
  if (/カメラ|焦点距離|構図|寄って|引いて|肩越し|見下ろ|見上げ/.test(instruction)) {
    const mm = instruction.match(/(\d+(?:\.\d+)?)\s*(?:mm|ミリ)/i);
    if (mm) { const lens = Number(mm[1]); if (lens >= 10 && lens <= 250) return { kind: 'camera', lens }; }
    if (/寄|ズームイン/.test(instruction)) return { kind: 'camera', factor: 1.2 };
    if (/引|ズームアウト/.test(instruction)) return { kind: 'camera', factor: 1 / 1.2 };
    return { kind: 'scene' };
  }
  if (/ポーズ|二人.*(距離|近|離)|立ち位置|体の向き/.test(instruction)) return { kind: 'scene' };
  return { kind: 'region' };
}
