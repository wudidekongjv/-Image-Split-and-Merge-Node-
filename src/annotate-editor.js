// 全屏标注编辑器（原生 DOM）。
//
// 为什么不用 React 的 position:fixed：宿主画布层和节点层都带
// transform: translate(...) scale(...)，CSS 规范里 fixed 会相对
// 「最近的 transform 祖先」定位，导致浮层被困在节点里并跟着缩放。
// 因此和导演台插件一致，直接把浮层挂到 document.body。
//
// 本模块只负责 DOM 结构与事件绑定；业务状态仍由 React 组件持有，
// 通过 getState() / actions / sync() 与组件通信。

function el(tag, style, text) {
    const node = document.createElement(tag);
    if (style) Object.assign(node.style, style);
    if (text != null) node.textContent = text;
    return node;
}

function button(label, onClick, style) {
    const node = el("button", {
        border: "1px solid #ffffff33",
        borderRadius: 8,
        padding: "5px 10px",
        background: "#242424",
        color: "#eee",
        cursor: "pointer",
        fontSize: 12,
        ...(style || {}),
    }, label);
    node.type = "button";
    node.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
    return node;
}

const TOOLS = [
    ["pen", "✏️ 画笔"],
    ["arrow", "➡️ 箭头"],
    ["rect", "▭ 方框"],
    ["text", "🔤 文字"],
    ["eraser", "🧽 橡皮"],
];

export function openNativeAnnotateEditor(api) {
    const { getState, actions, accent = "#4c8dff" } = api;

    const root = el("div", {
        position: "fixed", inset: "0", zIndex: "2147483000",
        background: "rgba(0,0,0,0.8)", display: "flex",
        alignItems: "center", justifyContent: "center", padding: "16px",
    });
    root.setAttribute("data-canvas-no-zoom", "true");

    // 彻底隔离宿主画布的拖拽 / 缩放 / 快捷键。
    for (const type of ["mousedown", "pointerdown", "wheel", "contextmenu"]) {
        root.addEventListener(type, (e) => e.stopPropagation());
    }

    const panel = el("div", {
        width: "min(1100px, 96vw)", maxHeight: "94vh",
        display: "flex", flexDirection: "column",
        background: "#141414", color: "#f5f5f5",
        border: "1px solid #ffffff22", borderRadius: "12px", overflow: "hidden",
    });

    // ── 工具条 ──
    const toolbar = el("div", {
        padding: "10px 12px", borderBottom: "1px solid #ffffff1a",
        display: "flex", gap: "6px", flexWrap: "wrap", alignItems: "center",
    });

    const toolButtons = TOOLS.map(([value, label]) => {
        const node = button(label, () => actions.setAnnotTool(value));
        toolbar.appendChild(node);
        return { value, node };
    });

    const colorLabel = el("label", { display: "flex", alignItems: "center", gap: "4px", fontSize: "11px" }, "颜色");
    const colorInput = el("input", { width: "30px", height: "26px", padding: "0", border: "none", background: "transparent" });
    colorInput.type = "color";
    colorInput.addEventListener("input", (e) => actions.setAnnotColor(e.target.value));
    colorLabel.appendChild(colorInput);
    toolbar.appendChild(colorLabel);

    const widthLabel = el("label", { display: "flex", alignItems: "center", gap: "4px", fontSize: "11px" }, "粗细");
    const widthInput = el("input", { width: "84px" });
    widthInput.type = "range"; widthInput.min = "1"; widthInput.max = "30";
    widthInput.addEventListener("input", (e) => actions.setAnnotWidth(Number(e.target.value)));
    const widthValue = el("span", { width: "20px" }, "");
    widthLabel.append(widthInput, widthValue);
    toolbar.appendChild(widthLabel);

    const fontLabel = el("label", { display: "flex", alignItems: "center", gap: "4px", fontSize: "11px" }, "字号");
    const fontInput = el("input", {
        width: "58px", padding: "4px 6px", borderRadius: "6px",
        border: "1px solid #ffffff33", background: "#242424", color: "#fff", fontSize: "12px",
    });
    fontInput.type = "number"; fontInput.min = "10"; fontInput.max = "120";
    fontInput.addEventListener("input", (e) => actions.setAnnotFontSize(Number(e.target.value)));
    fontLabel.appendChild(fontInput);
    toolbar.appendChild(fontLabel);

    const bgLabel = el("label", { display: "flex", alignItems: "center", gap: "4px", fontSize: "11px" });
    const bgCheckbox = el("input");
    bgCheckbox.type = "checkbox";
    bgCheckbox.addEventListener("change", (e) => actions.setAnnotTextBg(e.target.checked));
    bgLabel.append(bgCheckbox, document.createTextNode("文字底色"));
    toolbar.appendChild(bgLabel);

    toolbar.append(button("↶ 撤销", () => actions.undoAnnot()), button("🗑 清空", () => actions.clearAnnot()));
    const counter = el("span", { fontSize: "11px", color: "#aaa" }, "");
    toolbar.appendChild(counter);
    toolbar.appendChild(el("div", { flex: "1" }));
    toolbar.appendChild(button("关闭 ✕", () => actions.closeEditor()));

    // ── 画布区 ──
    const stage = el("div", {
        flex: "1", minHeight: "0", overflow: "auto",
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: "12px", background: "#0c0c0c",
    });
    const canvasWrap = el("div", { position: "relative", display: "inline-block", lineHeight: "0" });
    const canvas = el("canvas", {
        maxWidth: "100%", maxHeight: "calc(94vh - 200px)", width: "auto", height: "auto",
        display: "block", borderRadius: "6px", background: "#000", touchAction: "none",
    });
    canvas.addEventListener("pointerdown", (e) => api.onPointerDown(e));
    canvas.addEventListener("pointermove", (e) => api.onPointerMove(e));
    canvas.addEventListener("pointerup", (e) => api.onPointerUp(e));
    canvas.addEventListener("pointercancel", (e) => api.onPointerUp(e));
    canvasWrap.appendChild(canvas);

    // 文字输入浮层
    const labelBox = el("div", { position: "absolute", display: "none", gap: "4px", lineHeight: "normal", zIndex: "2" });
    const labelInput = el("input", {
        width: "180px", padding: "4px 8px", borderRadius: "6px",
        border: "1px solid #ffffff33", background: "#1e1e1e", color: "#fff", fontSize: "12px",
    });
    labelInput.placeholder = "输入文字，回车确认";
    labelInput.addEventListener("input", (e) => actions.setLabelDraft(e.target.value));
    labelInput.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") actions.addLabel();
        if (e.key === "Escape") actions.setPendingLabel(null);
    });
    labelBox.append(labelInput, button("确定", () => actions.addLabel()));
    for (const type of ["pointerdown", "mousedown"]) {
        labelBox.addEventListener(type, (e) => e.stopPropagation());
    }
    canvasWrap.appendChild(labelBox);
    stage.appendChild(canvasWrap);

    // ── 底部 ──
    const footer = el("div", {
        padding: "10px 12px", borderTop: "1px solid #ffffff1a",
        display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap",
    });
    footer.appendChild(el("span", { fontSize: "11px", color: "#aaa" },
        "画笔/箭头/方框拖拽绘制；文字点击放置；橡皮拖过删除整笔。坐标按图片比例保存，导出不跑位。"));
    footer.appendChild(el("div", { flex: "1" }));
    const generateButton = button("生成标注图预览", () => actions.buildAnnotated(), {
        background: accent, color: "#fff", fontWeight: "600",
    });
    footer.appendChild(generateButton);

    panel.append(toolbar, stage, footer);
    root.appendChild(panel);
    document.body.appendChild(root);

    // 同步 React state → 原生 DOM。
    function sync() {
        const s = getState();
        for (const { value, node } of toolButtons) {
            const active = s.annotTool === value;
            node.style.background = active ? accent : "#242424";
            node.style.color = active ? "#fff" : "#eee";
        }
        if (colorInput.value !== s.annotColor) colorInput.value = s.annotColor;
        if (widthInput.value !== String(s.annotWidth)) widthInput.value = String(s.annotWidth);
        widthValue.textContent = String(s.annotWidth);
        if (fontInput.value !== String(s.annotFontSize)) fontInput.value = String(s.annotFontSize);
        bgCheckbox.checked = s.annotTextBg;
        counter.textContent = `  ${s.strokes.length} 笔 · ${s.labels.length} 处文字`;
        canvas.style.cursor = s.annotTool === "text" ? "text" : "crosshair";
        generateButton.textContent = s.busy ? "生成中…" : "生成标注图预览";
        generateButton.disabled = Boolean(s.busy);

        if (s.pendingLabel) {
            labelBox.style.display = "flex";
            labelBox.style.left = `${s.pendingLabel.x * 100}%`;
            labelBox.style.top = `${s.pendingLabel.y * 100}%`;
            if (labelInput.value !== s.labelDraft) labelInput.value = s.labelDraft;
            if (document.activeElement !== labelInput) labelInput.focus();
        } else {
            labelBox.style.display = "none";
        }
        api.redraw();
    }

    function setImage(image, width, height) {
        const scale = Math.min(1, 1800 / Math.max(width, height));
        canvas.width = Math.max(1, Math.round(width * scale));
        canvas.height = Math.max(1, Math.round(height * scale));
        api.setImageRef(image);
        api.redraw();
    }

    function dispose() {
        root.remove();
    }

    return { root, canvas, sync, setImage, dispose };
}
