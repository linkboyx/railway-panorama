// 列车图层（deck.gl）：低缩放级别画圆点，高缩放级别画带方向的箭头，并显示车次号
/* global deck */
import { THEMES } from './map.js';

function makeAtlas() {
  const S = 64;
  const c = document.createElement('canvas');
  c.width = S * 2; c.height = S;
  const g = c.getContext('2d');
  const shape = (ox, grow) => {
    g.beginPath();
    // 指向正上方（北）的“子弹头”形状
    g.moveTo(ox + 32, 4 - grow);
    g.bezierCurveTo(ox + 44 + grow, 16, ox + 50 + grow, 30, ox + 50 + grow, 42);
    g.arc(ox + 32, 42, 18 + grow, 0, Math.PI, false);
    g.bezierCurveTo(ox + 14 - grow, 30, ox + 20 - grow, 16, ox + 32, 4 - grow);
    g.closePath();
    g.fill();
  };
  g.fillStyle = '#fff';
  shape(0, 0);      // 填充
  shape(S, 4);      // 描边（稍大）
  return {
    atlas: c,
    mapping: {
      fill: { x: 0, y: 0, width: S, height: S, anchorY: 36, mask: true },
      outline: { x: S, y: 0, width: S, height: S, anchorY: 36, mask: true },
    },
  };
}

export class TrainLayers {
  constructor(map, { onHover, onClick }) {
    this.map = map;
    this.onHover = onHover; this.onClick = onClick;
    const { atlas, mapping } = makeAtlas();
    this.atlas = atlas; this.mapping = mapping;
    this.overlay = new deck.MapboxOverlay({ interleaved: false, layers: [] });
    map.addControl(this.overlay);
    this.pulse = 0;
  }

  /**
   * frame: { n, pos: Float32Array(2n), ang: Float32Array(n), col: Uint8Array(4n), runs: [] }
   * sel: { lon, lat, code } | null；labels: [{lon, lat, code}]
   */
  render(frame, { zoom, theme, sel, labels }) {
    const T = THEMES[theme];
    const data = { length: frame.n, attributes: { getPosition: { value: frame.pos, size: 2 }, getColor: { value: frame.col, size: 4, normalized: true }, getFillColor: { value: frame.col, size: 4, normalized: true }, getAngle: { value: frame.ang, size: 1 } } };
    const pick = {
      pickable: true,
      onHover: (info) => this.onHover(info.index >= 0 ? frame.runs[info.index] : null, info),
      onClick: (info) => { if (info.index >= 0) this.onClick(frame.runs[info.index]); return true; },
    };
    const layers = [];
    const icons = zoom >= 6.3;
    if (!icons) {
      layers.push(new deck.ScatterplotLayer({
        id: 'train-dots', data, ...pick,
        radiusUnits: 'pixels', getRadius: zoom < 4.5 ? 2.2 : zoom < 5.5 ? 2.8 : 3.4,
        stroked: true, lineWidthUnits: 'pixels', getLineWidth: 0.8, getLineColor: T.trainStroke,
        updateTriggers: { getRadius: zoom, getLineColor: theme },
      }));
    } else {
      const size = zoom < 8 ? 15 : zoom < 10 ? 19 : 23;
      const common = { iconAtlas: this.atlas, iconMapping: this.mapping, sizeUnits: 'pixels', billboard: false, getSize: size };
      layers.push(new deck.IconLayer({ id: 'train-outline', data, ...common, getIcon: () => 'outline', getColor: T.trainStroke, updateTriggers: { getColor: theme, getSize: size } }));
      layers.push(new deck.IconLayer({ id: 'train-icons', data, ...common, ...pick, getIcon: () => 'fill', updateTriggers: { getSize: size } }));
    }
    if (labels && labels.length) {
      layers.push(new deck.TextLayer({
        id: 'train-labels', data: labels, getPosition: (d) => [d.lon, d.lat], getText: (d) => d.code,
        getSize: 11.5, getColor: T.labelColor, getPixelOffset: [13, -1], getTextAnchor: 'start', getAlignmentBaseline: 'center',
        fontFamily: '-apple-system, "PingFang SC", "Microsoft YaHei", Roboto, sans-serif', fontWeight: 600,
        fontSettings: { sdf: true, fontSize: 48, buffer: 6 }, outlineWidth: 3, outlineColor: T.labelHalo, characterSet: 'auto',
        updateTriggers: { getColor: theme },
      }));
    }
    if (sel) {
      this.pulse = (this.pulse + 0.04) % 1;
      const r = 11 + 7 * this.pulse;
      layers.push(new deck.ScatterplotLayer({
        id: 'sel-ring', data: [sel], getPosition: (d) => [d.lon, d.lat], radiusUnits: 'pixels', getRadius: r,
        filled: false, stroked: true, lineWidthUnits: 'pixels', getLineWidth: 2.5,
        getLineColor: [...sel.color, Math.round(255 * (1 - this.pulse * 0.8))], updateTriggers: { getRadius: r, getLineColor: this.pulse },
      }));
      layers.push(new deck.TextLayer({
        id: 'sel-label', data: [sel], getPosition: (d) => [d.lon, d.lat], getText: (d) => d.code,
        getSize: 14, getColor: T.labelColor, getPixelOffset: [0, -24], getTextAnchor: 'middle', getAlignmentBaseline: 'bottom',
        fontFamily: '-apple-system, "PingFang SC", "Microsoft YaHei", Roboto, sans-serif', fontWeight: 700,
        fontSettings: { sdf: true, fontSize: 48, buffer: 6 }, outlineWidth: 4, outlineColor: T.labelHalo, characterSet: 'auto',
      }));
    }
    this.overlay.setProps({ layers });
  }
}
