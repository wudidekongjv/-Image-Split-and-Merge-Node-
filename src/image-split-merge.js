// Infinite Canvas 图片拆分与合并节点插件 —— 独立安装，不依赖宿主源码或 React 包。
// 只使用 Infinite Canvas 公开的工厂运行时契约（runtime.React / ctx.*）。
//
// 功能：
//   1) 拆分（切割）：网格均分（N×M）+ 自定义图框（预览图上鼠标拉矩形，可拉多个，按绘制顺序拆出）
//   2) 合并（拼接）：网格拼接多张图，带分割线、自动标注图号、图号后可加批注
// 图片来源：上游图片节点 + 本地导入，都支持。
// 图片地址可能是 dataURL / blob / https://canvas-assets/xxx（走宿主 materialDataUrl 通道）。

function randomId(prefix) {
    if (typeof crypto?.randomUUID === "function") return `${prefix}-${crypto.randomUUID()}`;
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// 把图片源地址解析成「浏览器可加载」的地址（复刻宿主 hushifu-bridge 逻辑）。
async function resolveImageSource(src) {
    const value = String(src || "");
    if (!value) return null;
    if (value.startsWith("data:") || value.startsWith("blob:")) return value;

    const host = (typeof window !== "undefined" && window.hushifuHost) || null;
    const canvasAsset = value.match(/^https:\/\/canvas-assets\/([^/?#]+)/i);
    if (canvasAsset && host && typeof host.materialDataUrl === "function") {
        try {
            const dataUrl = await host.materialDataUrl(canvasAsset[1]);
            if (typeof dataUrl === "string" && dataUrl.startsWith("data:")) return dataUrl;
        } catch (_error) {
            // 忽略，走下面报错。
        }
        throw new Error("无法从宿主读取该图片素材（canvas-assets 通道失败）");
    }

    if (value.startsWith("http://") || value.startsWith("https://")) {
        try {
            const response = await fetch(value, { cache: "no-store" });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const blob = await response.blob();
            if (blob.type.includes("json") || blob.type.startsWith("text/")) throw new Error("远程地址返回的不是图片");
            return URL.createObjectURL(blob);
        } catch (error) {
            throw new Error(`图片下载失败：${error instanceof Error ? error.message : String(error)}`);
        }
    }

    return value;
}

// 加载图片，返回 { image, width, height }。
function loadImage(src) {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve({ image, width: image.naturalWidth, height: image.naturalHeight });
        image.onerror = () => reject(new Error("图片加载失败"));
        image.src = src;
    });
}

// 判断上游节点是否携带可用图片数据。
function extractImageSource(node) {
    if (!node) return null;
    const isImageType = node.type === "image" || node.type === "panorama";
    const content = node.metadata?.content;
    if (!isImageType || typeof content !== "string" || !content) return null;
    return { id: node.id, src: content, name: node.title || "画布图片" };
}

function buildImageSources(ctx) {
    const upstream = ctx.getUpstream();
    return upstream.map(extractImageSource).filter(Boolean);
}

// 输出图片原始尺寸。
function imageSize(dataUrl) {
    return new Promise((resolve) => {
        const image = new Image();
        image.onload = () => resolve({ width: image.naturalWidth || 512, height: image.naturalHeight || 512 });
        image.onerror = () => resolve({ width: 512, height: 512 });
        image.src = dataUrl;
    });
}

function fitImageSize(width, height) {
    const maxWidth = 420;
    const maxHeight = 360;
    const scale = Math.min(1, maxWidth / Math.max(width, 1), maxHeight / Math.max(height, 1));
    return { width: Math.max(120, Math.round(width * scale)), height: Math.max(90, Math.round(height * scale)) };
}

// 把一批图片回传为画布图片节点并连线。
async function sendImages(ctx, images) {
    if (!images.length) return;
    const node = ctx.node;
    const nodes = ctx.getNodes();
    const connections = ctx.getConnections();
    let y = node.position.y;
    for (const connection of connections) {
        if (connection.fromNodeId !== node.id) continue;
        const output = nodes.find((item) => item.id === connection.toNodeId);
        if (output?.type === "image") y = Math.max(y, output.position.y + output.height + 28);
    }

    const ops = [];
    for (const [index, img] of images.entries()) {
        if (typeof img?.dataUrl !== "string" || !img.dataUrl.startsWith("data:image/")) continue;
        const natural = await imageSize(img.dataUrl);
        const size = fitImageSize(natural.width, natural.height);
        const id = randomId("split-image");
        const title = img.fileName || `切片-${index + 1}.png`;
        ops.push({
            type: "add_node",
            id,
            nodeType: "image",
            title,
            x: node.position.x + node.width + 88,
            y,
            width: size.width,
            height: size.height,
            metadata: { content: img.dataUrl, status: "success", naturalWidth: natural.width, naturalHeight: natural.height, mimeType: "image/png" },
        });
        ops.push({ type: "connect_nodes", fromNodeId: node.id, toNodeId: id });
        y += size.height + 28;
    }
    if (ops.length) ctx.applyOps(ops);
}

// ────────────────────────────────────────────────────────────
// 拆分：把图片按指定区域切成多块，返回 dataURL 数组。
// regions: [{x, y, w, h}]（相对原图像素坐标）
// ────────────────────────────────────────────────────────────
async function splitByRegions(src, regions) {
    const { image, width, height } = await loadImage(src);
    return regions.map((region, index) => {
        const x = Math.max(0, Math.round(region.x));
        const y = Math.max(0, Math.round(region.y));
        const w = Math.min(width - x, Math.max(1, Math.round(region.w)));
        const h = Math.min(height - y, Math.max(1, Math.round(region.h)));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const context = canvas.getContext("2d");
        context.drawImage(image, x, y, w, h, 0, 0, w, h);
        return { dataUrl: canvas.toDataURL("image/png"), region: { x, y, w, h }, index };
    });
}

// 网格均分：把图片切成 cols × rows 块。
function gridRegions(width, height, cols, rows) {
    const regions = [];
    const cellW = width / cols;
    const cellH = height / rows;
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            regions.push({ x: c * cellW, y: r * cellH, w: cellW, h: cellH });
        }
    }
    return regions;
}

// ────────────────────────────────────────────────────────────
// 合并：把多张图拼成网格，带分割线、图号、批注。
// items: [{ src, caption }]，caption 可为空字符串（可含 \n 换行）。
// 字号可调；文字较多时按最大宽度自动换行，行距随字号自适应。
// ────────────────────────────────────────────────────────────
async function mergeGrid(items, opts) {
    const cols = opts.cols || 2;
    const lineColor = opts.lineColor || "#ffffff";
    const lineWidth = opts.lineWidth || 2;
    const showNumbers = opts.showNumbers !== false;
    const captionColor = opts.captionColor || "#ffffff";
    const captionBg = opts.captionBg || "rgba(0,0,0,0.55)";
    const fontPx = Math.max(8, Number(opts.fontPx) || 16);

    // 先加载所有图片，取统一尺寸（用第一张的尺寸为准，其余等比缩放到同尺寸）。
    const loaded = [];
    for (const item of items) {
        const { image, width, height } = await loadImage(item.src);
        loaded.push({ image, width, height, caption: item.caption || "" });
    }
    if (!loaded.length) throw new Error("没有可合并的图片");

    const cellW = loaded[0].width;
    const cellH = loaded[0].height;
    const rows = Math.ceil(loaded.length / cols);
    const totalW = cellW * cols + lineWidth * (cols + 1);
    const totalH = cellH * rows + lineWidth * (rows + 1);

    const canvas = document.createElement("canvas");
    canvas.width = totalW;
    canvas.height = totalH;
    const context = canvas.getContext("2d");

    // 背景 + 分割线底色
    context.fillStyle = lineColor;
    context.fillRect(0, 0, totalW, totalH);

    const lineHeight = Math.round(fontPx * 1.35); // 行距随字号自适应
    const padX = 8;
    const padY = 5;

    loaded.forEach((item, index) => {
        const c = index % cols;
        const r = Math.floor(index / cols);
        const dx = lineWidth + c * (cellW + lineWidth);
        const dy = lineWidth + r * (cellH + lineWidth);
        // 居中等比缩放填充到 cell
        const scale = Math.min(cellW / item.width, cellH / item.height);
        const w = item.width * scale;
        const h = item.height * scale;
        const ox = dx + (cellW - w) / 2;
        const oy = dy + (cellH - h) / 2;
        context.drawImage(item.image, ox, oy, w, h);

        // 图号 + 批注（支持多行、按宽度自动换行）
        const numberText = showNumbers ? String(index + 1) : "";
        const captionText = item.caption ? String(item.caption).trim() : "";
        if (!numberText && !captionText) return;

        context.font = `bold ${fontPx}px system-ui, sans-serif`;

        // 把「图号 + 批注」拆成可换行的行（图号单独一行或与首行批注拼接）。
        const maxTextWidth = Math.max(60, cellW - padX * 2);
        const rawLines = String(captionText || "").split("\n");
        const lines = [];
        if (numberText) {
            // 图号放首行，后接首行批注（若有）。
            if (rawLines.length && rawLines[0]) {
                lines.push(`${numberText} ${rawLines[0]}`);
                for (let i = 1; i < rawLines.length; i++) lines.push(rawLines[i]);
            } else {
                lines.push(numberText);
                for (const l of rawLines) if (l) lines.push(l);
            }
        } else {
            for (const l of rawLines) if (l) lines.push(l);
        }

        // 按宽度自动换行。
        const wrapped = [];
        for (const line of lines) {
            let current = "";
            for (const ch of line) {
                if (context.measureText(current + ch).width > maxTextWidth && current) {
                    wrapped.push(current);
                    current = ch;
                } else {
                    current += ch;
                }
            }
            if (current) wrapped.push(current);
        }
        if (!wrapped.length) return;

        const textBlockH = wrapped.length * lineHeight + padY * 2;
        let maxLineW = 0;
        for (const line of wrapped) maxLineW = Math.max(maxLineW, context.measureText(line).width);
        const bw = Math.min(cellW - padX, maxLineW + padX * 2);
        const bx = dx + 4;
        const by = dy + 4;

        context.fillStyle = captionBg;
        context.fillRect(bx, by, bw, textBlockH);
        context.fillStyle = captionColor;
        context.textBaseline = "top";
        wrapped.forEach((line, i) => {
            context.fillText(line, bx + padX, by + padY + i * lineHeight);
        });
    });

    return canvas.toDataURL("image/png");
}

function ImageSplitMergeContent({ ctx, React }) {
    const h = React.createElement;

    // 图片来源
    const [imageSrc, setImageSrc] = React.useState(null);      // 原始地址（用于拆分的源图）
    const [resolvedSrc, setResolvedSrc] = React.useState(null); // 解析后可加载地址
    const [imageName, setImageName] = React.useState("");
    const [imgMeta, setImgMeta] = React.useState({ width: 0, height: 0 });

    // 拆分参数
    const [splitMode, setSplitMode] = React.useState("grid"); // "grid" | "custom"
    const [gridCols, setGridCols] = React.useState(2);
    const [gridRows, setGridRows] = React.useState(2);
    const [customBoxes, setCustomBoxes] = React.useState([]); // [{x,y,w,h}] 相对图片像素坐标

    // 合并参数
    const [mergeCols, setMergeCols] = React.useState(2);
    const [lineColor, setLineColor] = React.useState("#ffffff");
    const [lineWidth, setLineWidth] = React.useState(2);
    const [showNumbers, setShowNumbers] = React.useState(true);
    const [fontPx, setFontPx] = React.useState(16);

    // 合并图片列表（每项 { key, src, resolvedSrc, caption, name, width, height }）
    const [mergeItems, setMergeItems] = React.useState([]);
    const [focusItemKey, setFocusItemKey] = React.useState(null); // 当前放大编辑的图

    // 结果预览
    const [splitPreviews, setSplitPreviews] = React.useState([]); // 拆分结果
    const [mergePreview, setMergePreview] = React.useState(null);  // 合并结果
    const [busy, setBusy] = React.useState(false);
    const [status, setStatus] = React.useState("");

    const ctxRef = React.useRef(ctx);
    ctxRef.current = ctx;
    const fileInputRef = React.useRef(null);
    const canvasRef = React.useRef(null);
    const drawingRef = React.useRef(null); // 拖拽中 { startX, startY } 相对图片坐标

    // 从上游自动识别图片源：第一张作为「拆分」源图，全部进入「合并」列表。
    React.useEffect(() => {
        const sources = buildImageSources(ctxRef.current);
        if (!sources.length) return;
        const first = sources[0];
        void (async () => {
            try {
                // 解析所有上游图片。
                const resolvedItems = [];
                for (const s of sources) {
                    const resolved = await resolveImageSource(s.src);
                    if (!resolved) continue;
                    const { width, height } = await loadImage(resolved);
                    resolvedItems.push({ key: `up-${s.id}`, src: s.src, resolvedSrc: resolved, caption: "", name: s.name, width, height });
                }
                // 合并列表 = 上游图片（替换旧的上游项，保留本地导入项）。
                setMergeItems((prev) => {
                    const localItems = prev.filter((it) => it.key.startsWith("local-"));
                    return [...resolvedItems, ...localItems];
                });

                // 拆分源图用第一张上游。
                const f = resolvedItems[0];
                if (f) {
                    setImageSrc(f.src);
                    setResolvedSrc(f.resolvedSrc);
                    setImageName(f.name);
                    setImgMeta({ width: f.width, height: f.height });
                }
                setStatus("");
            } catch (error) {
                setStatus(`图片加载失败：${error instanceof Error ? error.message : String(error)}`);
            }
        })();
    }, [JSON.stringify(buildImageSources(ctxRef.current).map((s) => s.id))]);

    const handleFile = (event) => {
        const file = event.target?.files?.[0];
        if (!file) return;
        const url = URL.createObjectURL(file);
        void (async () => {
            try {
                const { width, height } = await loadImage(url);
                // 作为拆分源图。
                setImageSrc(url);
                setResolvedSrc(url);
                setImageName(file.name || "导入图片");
                setImgMeta({ width, height });
                setCustomBoxes([]);
                setSplitPreviews([]);
                setMergePreview(null);
                // 加入合并列表。
                const item = { key: `local-${randomId("img")}`, src: url, resolvedSrc: url, caption: "", name: file.name || "导入图片", width, height };
                setMergeItems((prev) => [...prev, item]);
                setStatus("");
            } catch (error) {
                setStatus(`图片加载失败：${error instanceof Error ? error.message : String(error)}`);
            }
        })();
    };

    // 删除合并列表中的一张图。
    const removeMergeItem = (key) => {
        setMergeItems((prev) => prev.filter((it) => it.key !== key));
        if (focusItemKey === key) setFocusItemKey(null);
        setMergePreview(null);
    };

    // 更新某张图的批注。
    const updateMergeCaption = (key, caption) => {
        setMergeItems((prev) => prev.map((it) => (it.key === key ? { ...it, caption } : it)));
    };

    // 拆分执行。
    const doSplit = async () => {
        if (!resolvedSrc) { setStatus("请先导入或连接图片"); return; }
        setBusy(true);
        setStatus("");
        try {
            let regions;
            if (splitMode === "grid") {
                const cols = Math.max(1, Number(gridCols) || 1);
                const rows = Math.max(1, Number(gridRows) || 1);
                if (cols * rows > 64) { setStatus("切块数量过多（最多 64 块）"); setBusy(false); return; }
                regions = gridRegions(imgMeta.width, imgMeta.height, cols, rows);
            } else {
                if (!customBoxes.length) { setStatus("请先在预览图上拖拽绘制至少一个图框"); setBusy(false); return; }
                regions = customBoxes;
            }
            const results = await splitByRegions(resolvedSrc, regions);
            setSplitPreviews(results.map((r, i) => ({ key: randomId("split"), dataUrl: r.dataUrl, fileName: `${(imageName.replace(/\.[^.]+$/, "") || "切片")}-${i + 1}.png` })));
            setMergePreview(null);
        } catch (error) {
            setStatus(`拆分失败：${error instanceof Error ? error.message : String(error)}`);
        } finally {
            setBusy(false);
        }
    };

    // 合并执行：用 mergeItems 列表里的所有图。
    const doMerge = async () => {
        setBusy(true);
        setStatus("");
        try {
            if (!mergeItems.length) { setStatus("没有可合并的图片（请连接上游图片或导入）"); setBusy(false); return; }

            const resolvedList = mergeItems.map((it) => ({ src: it.resolvedSrc || it.src, caption: it.caption || "" }));

            const cols = Math.max(1, Number(mergeCols) || 1);
            const dataUrl = await mergeGrid(resolvedList, {
                cols,
                lineColor,
                lineWidth: Math.max(0, Number(lineWidth) || 0),
                showNumbers,
                captionColor: "#ffffff",
                captionBg: "rgba(0,0,0,0.55)",
                fontPx: Number(fontPx) || 16,
            });
            setMergePreview({ key: randomId("merge"), dataUrl, fileName: "拼接图.png" });
            setSplitPreviews([]);
        } catch (error) {
            setStatus(`合并失败：${error instanceof Error ? error.message : String(error)}`);
        } finally {
            setBusy(false);
        }
    };

    // 回传拆分结果。
    const exportSplit = async () => {
        if (!splitPreviews.length) { setStatus("没有可回传的切片"); return; }
        setBusy(true);
        try {
            await sendImages(ctxRef.current, splitPreviews);
            setStatus(`已回传 ${splitPreviews.length} 张切片到画布`);
        } catch (error) {
            setStatus(`回传失败：${error instanceof Error ? error.message : String(error)}`);
        } finally {
            setBusy(false);
        }
    };

    // 回传合并结果。
    const exportMerge = async () => {
        if (!mergePreview) { setStatus("没有可回传的拼接图"); return; }
        setBusy(true);
        try {
            await sendImages(ctxRef.current, [mergePreview]);
            setStatus("已回传拼接图到画布");
        } catch (error) {
            setStatus(`回传失败：${error instanceof Error ? error.message : String(error)}`);
        } finally {
            setBusy(false);
        }
    };

    // 自定义图框的鼠标交互：在预览图上拖拽画矩形。
    const previewMouseDown = (event) => {
        if (splitMode !== "custom" || !canvasRef.current) return;
        const rect = canvasRef.current.getBoundingClientRect();
        const x = (event.clientX - rect.left) / rect.width * imgMeta.width;
        const y = (event.clientY - rect.top) / rect.height * imgMeta.height;
        drawingRef.current = { startX: x, startY: y, curX: x, curY: y };
        event.stopPropagation();
    };
    const previewMouseMove = (event) => {
        if (!drawingRef.current || !canvasRef.current) return;
        const rect = canvasRef.current.getBoundingClientRect();
        const x = (event.clientX - rect.left) / rect.width * imgMeta.width;
        const y = (event.clientY - rect.top) / rect.height * imgMeta.height;
        drawingRef.current.curX = x;
        drawingRef.current.curY = y;
        drawOverlay();
        event.stopPropagation();
    };
    const previewMouseUp = (event) => {
        if (!drawingRef.current) return;
        const d = drawingRef.current;
        drawingRef.current = null;
        const x = Math.min(d.startX, d.curX);
        const y = Math.min(d.startY, d.curY);
        const w = Math.abs(d.curX - d.startX);
        const hgt = Math.abs(d.curY - d.startY);
        if (w < 4 || hgt < 4) { drawOverlay(); return; } // 太小忽略
        const box = { x, y, w, h: hgt };
        setCustomBoxes((prev) => [...prev, box]);
        event.stopPropagation();
    };

    const drawOverlay = () => {
        const cv = canvasRef.current;
        if (!cv) return;
        const ctx2 = cv.getContext("2d");
        const cw = cv.width, ch = cv.height;
        // 重绘：清空 → 画原图 → 画已有框 + 拖拽中框。
        // 原图重绘需要 resolvedSrc 对应的 image 对象；用 <img> 缓存的自然图。
        const draw = () => {
            const img = cv._img;
            if (img) ctx2.drawImage(img, 0, 0, cw, ch);
            ctx2.strokeStyle = "#4c8dff";
            ctx2.lineWidth = 2;
            ctx2.setLineDash([4, 3]);
            customBoxes.forEach((box, i) => {
                const bx = box.x / imgMeta.width * cw;
                const by = box.y / imgMeta.height * ch;
                const bw = box.w / imgMeta.width * cw;
                const bh = box.h / imgMeta.height * ch;
                ctx2.strokeRect(bx, by, bw, bh);
                ctx2.fillStyle = "#4c8dff";
                ctx2.fillText(String(i + 1), bx + 4, by + 14);
            });
            if (drawingRef.current) {
                const d = drawingRef.current;
                const bx = Math.min(d.startX, d.curX) / imgMeta.width * cw;
                const by = Math.min(d.startY, d.curY) / imgMeta.height * ch;
                const bw = Math.abs(d.curX - d.startX) / imgMeta.width * cw;
                const bh = Math.abs(d.curY - d.startY) / imgMeta.height * ch;
                ctx2.strokeRect(bx, by, bw, bh);
            }
            ctx2.setLineDash([]);
        };
        if (!cv._img && resolvedSrc) {
            const img = new Image();
            img.onload = () => { cv._img = img; draw(); };
            img.src = resolvedSrc;
        } else {
            draw();
        }
    };

    // 当进入自定义模式或框变化时，绘制 overlay。
    React.useEffect(() => {
        if (splitMode === "custom" && resolvedSrc && canvasRef.current) {
            drawOverlay();
        }
    }, [splitMode, customBoxes, resolvedSrc]);

    const muted = ctx.theme.node.muted;
    const text = ctx.theme.node.text;
    const stroke = ctx.theme.node.stroke;

    const labelStyle = { fontSize: 11, color: muted, marginBottom: 3 };
    const inputStyle = {
        background: ctx.theme.toolbar.itemHover || "transparent",
        border: `1px solid ${stroke}`,
        borderRadius: 6,
        padding: "4px 8px",
        color: text,
        fontSize: 12,
        width: "100%",
        boxSizing: "border-box",
    };
    const buttonStyle = {
        border: `1px solid ${stroke}`,
        borderRadius: 8,
        padding: "6px 12px",
        background: ctx.theme.toolbar.itemHover,
        color: text,
        cursor: "pointer",
        fontSize: 12,
    };
    const primaryStyle = { ...buttonStyle, background: ctx.theme.accent || "#4c8dff", color: "#fff", fontWeight: 600 };

    const tabButton = (value, label) =>
        h("button", {
            type: "button",
            style: { ...buttonStyle, flex: 1, background: value === splitMode ? (ctx.theme.accent || "#4c8dff") : ctx.theme.toolbar.itemHover, color: value === splitMode ? "#fff" : text },
            onClick: () => setSplitMode(value),
        }, label);

    return h(
        "div",
        { "data-canvas-no-zoom": true, style: { display: "flex", flexDirection: "column", gap: 10, padding: 12, width: "100%", height: "100%", boxSizing: "border-box", overflowY: "auto", color: text, fontSize: 12 } },
        h("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
            h("span", { style: { fontSize: 18 } }, "🧩"),
            h("span", { style: { fontSize: 14, fontWeight: 600 } }, "图片拆分与合并"),
        ),
        // 图片来源
        h("div", null,
            h("div", { style: labelStyle }, "图片来源"),
            h("input", { ref: fileInputRef, type: "file", accept: "image/*", style: { display: "none" }, onChange: handleFile }),
            h("div", { style: { display: "flex", gap: 6, alignItems: "center" } },
                h("button", { type: "button", style: buttonStyle, onClick: () => fileInputRef.current?.click() }, "导入图片"),
                resolvedSrc ? h("span", { style: { fontSize: 11, color: muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, `${imageName || "已加载"} ${imgMeta.width}×${imgMeta.height}`) : h("span", { style: { fontSize: 11, color: muted } }, "也可连接上游图片节点"),
            ),
        ),
        // ── 拆分 ──
        h("div", { style: { fontSize: 13, fontWeight: 600, marginTop: 4 } }, "拆分（切割）"),
        h("div", { style: { display: "flex", gap: 6 } },
            tabButton("grid", "网格均分"),
            tabButton("custom", "自定义图框"),
        ),
        splitMode === "grid"
            ? h("div", null,
                h("div", { style: { display: "flex", gap: 8 } },
                    h("div", { style: { flex: 1 } },
                        h("div", { style: labelStyle }, "列数"),
                        h("input", { type: "number", min: 1, max: 8, value: gridCols, style: inputStyle, onChange: (e) => setGridCols(Number(e.target.value)) }),
                    ),
                    h("div", { style: { flex: 1 } },
                        h("div", { style: labelStyle }, "行数"),
                        h("input", { type: "number", min: 1, max: 8, value: gridRows, style: inputStyle, onChange: (e) => setGridRows(Number(e.target.value)) }),
                    ),
                ),
            )
            : h("div", null,
                resolvedSrc
                    ? h("div", null,
                        h("div", { style: labelStyle }, "在图上拖拽画图框（按绘制顺序拆出，已画 " + customBoxes.length + " 个）"),
                        h("canvas", {
                            ref: canvasRef,
                            width: imgMeta.width,
                            height: imgMeta.height,
                            style: { width: "100%", borderRadius: 8, border: `1px solid ${stroke}`, cursor: "crosshair", background: "#000" },
                            onMouseDown: previewMouseDown,
                            onMouseMove: previewMouseMove,
                            onMouseUp: previewMouseUp,
                        }),
                        h("button", { type: "button", style: { ...buttonStyle, marginTop: 6 }, onClick: () => { setCustomBoxes([]); drawOverlay(); } }, "清空图框"),
                    )
                    : h("div", { style: { fontSize: 11, color: muted } }, "请先导入或连接图片"),
            ),
        h("button", { type: "button", style: primaryStyle, onClick: doSplit, disabled: busy }, busy ? "处理中…" : "执行拆分"),
        splitPreviews.length
            ? h("div", null,
                h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center" } },
                    h("div", { style: labelStyle }, `拆分结果（${splitPreviews.length} 张）`),
                    h("button", { type: "button", style: buttonStyle, onClick: () => setSplitPreviews([]) }, "清空"),
                ),
                h("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(72px, 1fr))", gap: 6 } },
                    splitPreviews.map((p) => h("img", { key: p.key, src: p.dataUrl, alt: p.fileName, style: { width: "100%", borderRadius: 6, display: "block", background: "#000" } })),
                ),
                h("button", { type: "button", style: { ...primaryStyle, marginTop: 8 }, onClick: exportSplit, disabled: busy }, `回传 ${splitPreviews.length} 张切片到画布`),
            )
            : null,
        // ── 合并 ──
        h("div", { style: { fontSize: 13, fontWeight: 600, marginTop: 4, borderTop: `1px solid ${stroke}`, paddingTop: 10 } }, "合并（拼接）"),
        h("div", { style: { display: "flex", gap: 8 } },
            h("div", { style: { flex: 1 } },
                h("div", { style: labelStyle }, "每行列数"),
                h("input", { type: "number", min: 1, max: 12, value: mergeCols, style: inputStyle, onChange: (e) => setMergeCols(Number(e.target.value)) }),
            ),
            h("div", { style: { flex: 1 } },
                h("div", { style: labelStyle }, "分割线宽度(px)"),
                h("input", { type: "number", min: 0, max: 20, value: lineWidth, style: inputStyle, onChange: (e) => setLineWidth(Number(e.target.value)) }),
            ),
        ),
        h("div", { style: { display: "flex", gap: 8, alignItems: "center" } },
            h("div", { style: { flex: 1 } },
                h("div", { style: labelStyle }, "分割线颜色"),
                h("input", { type: "color", value: lineColor, style: { ...inputStyle, height: 28, padding: 0 }, onChange: (e) => setLineColor(e.target.value) }),
            ),
            h("div", { style: { flex: 1 } },
                h("div", { style: labelStyle }, "标注字号(px)"),
                h("input", { type: "number", min: 8, max: 64, value: fontPx, style: inputStyle, onChange: (e) => setFontPx(Number(e.target.value)) }),
            ),
            h("label", { style: { flex: 1, display: "flex", alignItems: "center", gap: 6, fontSize: 12 } },
                h("input", { type: "checkbox", checked: showNumbers, onChange: (e) => setShowNumbers(e.target.checked) }),
                "标注图号",
            ),
        ),
        // 合并图片列表：缩略图 + 序号 + 悬停删除。
        h("div", null,
            h("div", { style: labelStyle }, `合并图片（${mergeItems.length} 张，单击编辑批注，悬停右上角删除）`),
            mergeItems.length
                ? h("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(76px, 1fr))", gap: 6 } },
                    mergeItems.map((item, index) => {
                        const isFocus = focusItemKey === item.key;
                        return h("div", {
                            key: item.key,
                            style: { position: "relative", cursor: "pointer", borderRadius: 6, overflow: "hidden", border: isFocus ? `2px solid ${ctx.theme.accent || "#4c8dff"}` : "1px solid transparent", background: "#000" },
                            onClick: () => setFocusItemKey(isFocus ? null : item.key),
                        },
                            h("img", { src: item.resolvedSrc || item.src, alt: item.name, style: { width: "100%", aspectRatio: "1/1", objectFit: "cover", display: "block" } }),
                            // 左下序号
                            h("div", { style: { position: "absolute", left: 4, bottom: 4, minWidth: 18, height: 18, padding: "0 4px", background: "rgba(0,0,0,0.6)", color: "#fff", fontSize: 11, fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 4 } }, String(index + 1)),
                            // 右上删除按钮（悬停显示）
                            h("div", {
                                style: { position: "absolute", right: 3, top: 3, width: 18, height: 18, background: "rgba(0,0,0,0.6)", color: "#fff", fontSize: 13, lineHeight: "18px", textAlign: "center", borderRadius: "50%", cursor: "pointer", opacity: 0, transition: "opacity 0.15s" },
                                title: "删除此图",
                                onMouseEnter: (e) => { e.currentTarget.style.opacity = 1; },
                                onMouseLeave: (e) => { e.currentTarget.style.opacity = 0; },
                                onClick: (e) => { e.stopPropagation(); removeMergeItem(item.key); },
                            }, "×"),
                            // 有批注时左下角上方显示一个小标记
                            item.caption ? h("div", { style: { position: "absolute", right: 3, bottom: 3, fontSize: 10, color: "#fff", background: "rgba(76,141,255,0.8)", padding: "0 4px", borderRadius: 3 } }, "批") : null,
                        );
                    }),
                )
                : h("div", { style: { fontSize: 11, color: muted } }, "请连接上游图片或导入图片"),
        ),
        // 单击图片后的放大预览 + 批注编辑。
        focusItemKey
            ? (() => {
                const focusItem = mergeItems.find((it) => it.key === focusItemKey);
                if (!focusItem) return null;
                return h("div", { style: { border: `1px solid ${stroke}`, borderRadius: 8, padding: 8, background: ctx.theme.toolbar.panel || "transparent" } },
                    h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 } },
                        h("div", { style: { fontSize: 11, color: muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, `第 ${mergeItems.findIndex((it) => it.key === focusItemKey) + 1} 张 · ${focusItem.name}`),
                        h("button", { type: "button", style: { ...buttonStyle, padding: "2px 8px", fontSize: 11 }, onClick: () => setFocusItemKey(null) }, "收起"),
                    ),
                    h("img", { src: focusItem.resolvedSrc || focusItem.src, alt: focusItem.name, style: { width: "100%", maxHeight: 200, objectFit: "contain", borderRadius: 6, display: "block", background: "#000" } }),
                    h("div", { style: { ...labelStyle, marginTop: 8 } }, "批注（可多行，合并时自动换行）"),
                    h("textarea", { value: focusItem.caption || "", rows: 3, style: { ...inputStyle, resize: "vertical" }, placeholder: "输入此图的批注…", onChange: (e) => updateMergeCaption(focusItemKey, e.target.value) }),
                );
            })()
            : null,
        h("button", { type: "button", style: primaryStyle, onClick: doMerge, disabled: busy }, busy ? "处理中…" : "执行合并"),
        mergePreview
            ? h("div", null,
                h("img", { src: mergePreview.dataUrl, alt: mergePreview.fileName, style: { width: "100%", borderRadius: 8, display: "block", background: "#000" } }),
                h("button", { type: "button", style: { ...primaryStyle, marginTop: 8 }, onClick: exportMerge, disabled: busy }, "回传拼接图到画布"),
            )
            : null,
        status ? h("div", { style: { color: "#ef9a9a", fontSize: 11 } }, status) : null,
    );
}

export default function createImageSplitMergePlugin(runtime) {
    const React = runtime.React;
    return {
        id: "image-split-merge",
        name: "图片拆分与合并",
        version: "0.2.0",
        minAppVersion: "0.12.0",
        description: "把图片拆分成多块（网格均分/自定义图框），或把多张图片拼接成带分割线、图号、批注的网格图。",
        nodes: [
            {
                type: "image:split-merge",
                title: "图片拆分与合并",
                icon: "🧩",
                description: "拆分图片（网格/图框）与合并图片（拼接+图号+批注）",
                defaultSize: { width: 380, height: 720 },
                defaultMetadata: {},
                hasSourceHandle: true,
                hidePanel: true,
                Content: (props) => ImageSplitMergeContent({ ...props, React }),
            },
        ],
    };
}
