// 二叉最小堆（优先级为浮点数，值为整数），用于 A*/Dijkstra
export class MinHeap {
  constructor(capacity = 1024) {
    this.keys = new Float64Array(capacity);
    this.vals = new Int32Array(capacity);
    this.size = 0;
  }
  clear() { this.size = 0; }
  grow() {
    const k = new Float64Array(this.keys.length * 2); k.set(this.keys); this.keys = k;
    const v = new Int32Array(this.vals.length * 2); v.set(this.vals); this.vals = v;
  }
  push(key, val) {
    if (this.size >= this.keys.length) this.grow();
    let i = this.size++;
    const keys = this.keys; const vals = this.vals;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= key) break;
      keys[i] = keys[p]; vals[i] = vals[p]; i = p;
    }
    keys[i] = key; vals[i] = val;
  }
  peekKey() { return this.keys[0]; }
  /** 弹出最小元素，返回值；最小键可在弹出前用 peekKey 读取 */
  pop() {
    const keys = this.keys; const vals = this.vals;
    const top = vals[0];
    const n = --this.size;
    if (n > 0) {
      const key = keys[n]; const val = vals[n];
      let i = 0;
      while (true) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && keys[c + 1] < keys[c]) c++;
        if (keys[c] >= key) break;
        keys[i] = keys[c]; vals[i] = vals[c]; i = c;
      }
      keys[i] = key; vals[i] = val;
    }
    return top;
  }
}
