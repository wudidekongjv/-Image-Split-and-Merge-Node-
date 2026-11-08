// 编辑器 DOM 冒烟测试：node test-editor.mjs
// 用最小假 DOM 真实执行「创建浮层 → 同步工具条 → 设置图片 → 绘制 → 销毁」，
// 捕获拼写错误、API 误用、空引用等运行时问题（不依赖浏览器 / jsdom）。

import { openNativeAnnotateEditor } from "./src/annotate-editor.js";
import { paintAnnotations } from "./src/image-split-merge.js";

const ctx2d = new Proxy({}, {
    get: (_t, key) => {
        if (key === "measureText") return () => ({ width: 42 });
        if (key === "canvas") return null;
        return () => {};
    },
    set: () => true,
});

class FakeElement {
    constructor(tag) {
        this.tagName = String(tag).toUpperCase();
        this.style = {};
        this.children = [];
        this.listeners = new Map();
        this.textContent = "";
        this.value = "";
        this.checked = false;
        this.disabled = false;
        this.width = 300;
        this.height = 200;
    }
    appendChild(node) { this.children.push(node); return node; }
    append(...nodes) { for (const n of nodes) this.children.push(n); }
    remove() { this.removed = true; }
    setAttribute() {}
    addEventListener(type, fn) { this.listeners.set(type, fn); }
    getContext() { return ctx2d; }
    getBoundingClientRect() { return { left: 0, top: 0, width: 300, height: 200 }; }
    focus() { this.focused = true; }
    setPointerCapture() {}
}

globalThis.document = {
    createElement: (tag) => new FakeElement(tag),
    createTextNode: (text) => ({ textContent: text }),
    body: new FakeElement("body"),
    activeElement: null,
};

let passed = 0, failed = 0;
function check(name, condition, extra = "") {
    if (condition) { passed++; console.log(`✅ ${name}`); }
    else { failed++; console.log(`❌ ${name} ${extra}`); }
}

const state = {
    annotTool: "pen", annotColor: "#ff3b30", annotWidth: 4,
    annotFontSize: 24, annotTextBg: true, strokes: [], labels: [],
    pendingLabel: null, labelDraft: "", busy: false,
};
const calls = { redraw: 0, setImageRef: 0, pointer: 0, closed: false, tool: null };

const editor = openNativeAnnotateEditor({
    getState: () => state,
    actions: {
        setAnnotTool: (v) => { calls.tool = v; },
        setAnnotColor: () => {}, setAnnotWidth: () => {}, setAnnotFontSize: () => {},
        setAnnotTextBg: () => {}, setLabelDraft: () => {}, setPendingLabel: () => {},
        clearAnnot: () => {}, undoAnnot: () => {}, buildAnnotated: () => {},
        addLabel: () => {}, closeEditor: () => { calls.closed = true; },
    },
    redraw: () => { calls.redraw++; },
    setImageRef: () => { calls.setImageRef++; },
    onPointerDown: () => { calls.pointer++; },
    onPointerMove: () => { calls.pointer++; },
    onPointerUp: () => { calls.pointer++; },
});

check("浮层挂到 document.body", document.body.children.includes(editor.root));
check("canvas 已创建", editor.canvas instanceof FakeElement);
check("固定定位 + 高 z-index", editor.root.style.position === "fixed" && editor.root.style.zIndex === "2147483000");

editor.sync();
check("sync 触发重绘", calls.redraw > 0);

state.annotTool = "text";
state.pendingLabel = { x: 0.3, y: 0.4 };
state.labelDraft = "这里要改";
state.strokes = [{ kind: "pen", color: "#f00", width: 0.01, points: [{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.5 }] }];
editor.sync();
check("工具切换 / 文字输入态同步无异常", true);

editor.setImage({ fake: true }, 4096, 2160);
check("大图按 1800 上限缩放画布", editor.canvas.width === 1800 && editor.canvas.height > 900 && editor.canvas.height < 1000,
    `${editor.canvas.width}x${editor.canvas.height}`);
check("setImageRef 被调用", calls.setImageRef > 0);

editor.canvas.listeners.get("pointerdown")({ clientX: 10, clientY: 10 });
editor.canvas.listeners.get("pointermove")({ clientX: 20, clientY: 20 });
editor.canvas.listeners.get("pointerup")({ clientX: 20, clientY: 20 });
check("指针事件能派发", calls.pointer === 3, `实际 ${calls.pointer}`);

// 绘制引擎：笔 / 箭头 / 方框 / 文字 / 草稿态
paintAnnotations(ctx2d, 1000, 600, [
    { kind: "pen", color: "#fff", width: 0.005, points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] },
    { kind: "arrow", color: "#fff", width: 0.005, from: { x: 0, y: 0 }, to: { x: 1, y: 1 } },
    { kind: "rect", color: "#fff", width: 0.005, from: { x: 0, y: 0 }, to: { x: 0.5, y: 0.5 } },
], [
    { x: 0.2, y: 0.2, text: "标注\n第二行", color: "#ff0", fontSize: 0.03, bg: true },
    { x: 0.6, y: 0.6, text: "无底色", color: "#0f0", fontSize: 0.03, bg: false },
], { kind: "pen", color: "#00f", width: 0.004, points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }] });
check("全部图元 + 多行文字绘制无异常", true);

editor.dispose();
check("关闭时从 DOM 移除", editor.root.removed === true);

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
if (failed) process.exit(1);
