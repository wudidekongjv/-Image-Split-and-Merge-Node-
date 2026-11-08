import { openNativeAnnotateEditor } from "./annotate-editor.js";

// Infinite Canvas 图片拆分与合并节点插件 —— 独立安装，不依赖宿主源码或 React 包。
// 只使用 Infinite Canvas 公开的工厂运行时契约（runtime.React / ctx.*）。
//
// 功能：
//   1) 拆分（切割）：网格均分（N×M）+ 自定义图框（预览图上鼠标拉矩形，可拉多个，按绘制顺序拆出）
//   2) 合并（拼接）：网格拼接多张图，带分割线、自动标注图号、图号后可加批注
//   3) 标注 / 涂鸦：全屏编辑器，自由画笔、箭头、方框、橡皮、文字标注，导出原分辨率 PNG
// 图片来源：普通图片节点 + 豆包等渠道生图节点 + 批量生成子节点 + 本地导入。
// 图片地址可能是 dataURL / blob / 跨域外链 / https://canvas-assets/xxx（走宿主通道）。

function randomId(prefix) {
    if (typeof crypto?.randomUUID === "function") return `${prefix}-${crypto.randomUUID()}`;
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// ────────────────────────────────────────────────────────────
// 上游图片识别（通用适配层）
//
// 历史问题：旧实现只认 node.type === "image" | "panorama" 且
// metadata.content 是字符串。豆包生图等宿主渠道节点是自定义类型、
// 批量生成节点（batchChildIds）、或把地址放在别的字段里，于是整条
// 上游被判为空。这里改成「字段白名单 + 结构展开 + 特征值兜底」。
// ────────────────────────────────────────────────────────────

// 宿主桥接对象在不同版本里名字不同，逐个尝试。
function hostBridge() {
    if (typeof window === "undefined") return null;
    return window.hushifuHost || window.canvasHost || window.__CANVAS_HOST__ || window.storyaiHost || null;
}

// 一个字符串是否「看起来像图片地址」。
function looksLikeImageUrl(value) {
    if (typeof value !== "string") return false;
    const v = value.trim();
    // dataURL / blob 可能高达数 MB，必须先判定再检查长度，否则会被下面的上限误杀。
    if (/^data:image\//i.test(v) || /^blob:/i.test(v)) return true;
    if (/^https:\/\/canvas-assets\//i.test(v)) return true;
    if (v.length < 8 || v.length > 20000) return false;
    if (!/^https?:\/\//i.test(v)) return false;
    if (/\.(png|jpe?g|webp|gif|bmp|avif|svg)(\?|#|$)/i.test(v)) return true;
    // 豆包 / 字节系 CDN 的图片外链常无扩展名，但路径带明显图片语义。
    if (/(byteimg|tos-|imagex|doubao|seedream|\/image\/|\/images\/|img[_-]?url|image_url)/i.test(v)) return true;
    return false;
}

// 这些字段可能直接装图片地址（按优先级）。
const IMAGE_FIELDS = [
    "content", "dataUrl", "imageUrl", "imageURL", "url", "src", "coverUrl", "thumbUrl",
    "downloadUrl", "download_url", "image", "output", "resultUrl", "result_url",
];
// 这些字段可能装「一组」图片地址或图片对象。
const IMAGE_LIST_FIELDS = [
    "images", "imageUrls", "image_urls", "urls", "results", "outputs", "items", "files", "data", "list",
];
// 文本类字段绝不当图片地址扫，避免把提示词里的链接误收。
const SKIP_KEYS = new Set([
    "prompt", "composerContent", "negativePrompt", "text", "title", "description",
    "errorDetails", "panoramaSourcePrompt", "panoramaFinalPrompt", "contentText",
]);

// 从一个值里挖出所有图片地址字符串（带深度上限，避免递归爆炸）。
function collectUrls(value, out, depth = 0) {
    if (depth > 4 || out.length > 40) return;
    if (typeof value === "string") {
        if (looksLikeImageUrl(value)) out.push(value.trim());
        return;
    }
    if (Array.isArray(value)) {
        for (const item of value) collectUrls(item, out, depth + 1);
        return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
        if (SKIP_KEYS.has(key)) continue;
        collectUrls(child, out, depth + 1);
    }
}

// 从单个节点里提取图片地址（返回去重后的数组）。
function extractNodeUrls(node) {
    const meta = node?.metadata || {};
    const found = [];

    // 1) 单值字段白名单
    for (const field of IMAGE_FIELDS) {
        const v = meta[field] ?? node?.[field];
        if (typeof v === "string" && looksLikeImageUrl(v)) found.push(v.trim());
    }
    // 2) 列表字段
    for (const field of IMAGE_LIST_FIELDS) {
        const v = meta[field] ?? node?.[field];
        if (v) collectUrls(v, found);
    }
    // 3) 兜底：mimeType 明确是图片时，浅扫整个 metadata
    if (!found.length && /^image\//i.test(String(meta.mimeType || ""))) collectUrls(meta, found, 1);
    // 4) 只有 storageKey 的情况：交给 resolveImageSource 走宿主通道
    if (!found.length && typeof meta.storageKey === "string" && meta.storageKey) {
        found.push(`canvas-storage://${meta.storageKey}`);
    }

    return [...new Set(found)];
}

// ctx.getUpstream() 在不同宿主版本里可能返回节点数组，或 {node, connection} 数组。
function normalizeUpstream(raw) {
    if (!raw) return [];
    const list = Array.isArray(raw) ? raw : [raw];
    return list.map((entry) => (entry && typeof entry === "object" && entry.node ? entry.node : entry)).filter(Boolean);
}

// 沿连接线向上多走几层，解决「豆包节点 → 中间节点 → 本节点」的间接上游。
function expandUpstream(ctx, direct, maxDepth = 2) {
    const allNodes = typeof ctx.getNodes === "function" ? ctx.getNodes() : [];
    const connections = typeof ctx.getConnections === "function" ? ctx.getConnections() : [];
    const byId = new Map(allNodes.map((n) => [n.id, n]));
    const result = [];
    const seen = new Set();

    const visit = (node, sourceLabel) => {
        if (!node || seen.has(node.id)) return;
        seen.add(node.id);
        result.push({ node, sourceLabel });
        // 批量生成节点：把子节点一起纳入（豆包一次出多张的关键）。
        const childIds = node.metadata?.batchChildIds;
        if (Array.isArray(childIds)) {
            for (const id of childIds) {
                const child = byId.get(id);
                if (child && !seen.has(child.id)) visit(child, `${sourceLabel} → 批量子图`);
            }
        }
    };

    let frontier = direct;
    for (let depth = 0; depth <= maxDepth && frontier.length; depth++) {
        const next = [];
        for (const node of frontier) {
            visit(node, depth === 0 ? "直接上游" : `间接上游 L${depth}`);
            for (const conn of connections) {
                if (conn.toNodeId !== node.id) continue;
                const parent = byId.get(conn.fromNodeId);
                if (parent && !seen.has(parent.id)) next.push(parent);
            }
        }
        frontier = next;
    }
    return result;
}

// 汇总：返回 [{ id, src, name, storageKey, mimeType, sourceLabel }]
function buildImageSources(ctx) {
    const direct = normalizeUpstream(typeof ctx.getUpstream === "function" ? ctx.getUpstream() : []);
    const entries = expandUpstream(ctx, direct, 2);
    const sources = [];
    const seenUrl = new Set();
    for (const { node, sourceLabel } of entries) {
        const urls = extractNodeUrls(node);
        urls.forEach((src, index) => {
            if (seenUrl.has(src)) return;
            seenUrl.add(src);
            sources.push({
                id: `${node.id}::${index}`,
                src,
                name: node.title || "上游图片",
                storageKey: node.metadata?.storageKey || "",
                mimeType: node.metadata?.mimeType || "",
                sourceLabel,
                nodeType: node.type || "unknown",
            });
        });
    }
    return sources;
}

// 把图片源地址解析成「浏览器可加载」的地址。
// 关键改动：远程地址 fetch 失败（跨域/CORS）不再直接抛错中断整批，
// 而是退回原地址让 <img> 自行尝试；canvas-assets / storageKey 走宿主通道。
async function resolveImageSource(src, storageKey) {
    const value = String(src || "");
    if (!value) return null;
    if (value.startsWith("data:") || value.startsWith("blob:")) return value;

    const host = hostBridge();

    // 虚拟素材地址：https://canvas-assets/<id>
    const canvasAsset = value.match(/^https:\/\/canvas-assets\/([^/?#]+)/i);
    const storageId = value.startsWith("canvas-storage://")
        ? value.slice("canvas-storage://".length)
        : (canvasAsset ? canvasAsset[1] : (storageKey || ""));

    if (storageId && host) {
        for (const method of ["materialDataUrl", "resolveImageUrl", "getImageUrl", "getMaterialUrl"]) {
            if (typeof host[method] !== "function") continue;
            try {
                const result = await host[method](storageId, value);
                if (typeof result === "string" && result && result !== value) return result;
            } catch (_error) { /* 试下一个通道 */ }
        }
    }
    if (canvasAsset) {
        // 宿主不给通道时，最后仍试原地址（有些版本是代理路由）。
        // 不直接抛错，避免一张失败拖垮整批。
    }

    if (/^https?:\/\//i.test(value)) {
        try {
            const response = await fetch(value, { cache: "no-store", mode: "cors" });
            if (response.ok) {
                const blob = await response.blob();
                if (blob.type && !blob.type.includes("json") && !blob.type.startsWith("text/")) {
                    return URL.createObjectURL(blob);
                }
            }
        } catch (_error) { /* 跨域被拦：退回原地址，交给 <img> */ }
        return value;
    }
    return value;
}

// 加载图片，返回 { image, width, height }。
// crossOrigin 尝试 anonymous，能让部分允许 CORS 的外链保留 canvas 可导出性。
function loadImage(src, withCors = false) {
    return new Promise((resolve, reject) => {
        const image = new Image();
        if (withCors && /^https?:\/\//i.test(src)) image.crossOrigin = "anonymous";
        image.onload = () => resolve({ image, width: image.naturalWidth, height: image.naturalHeight });
        image.onerror = () => reject(new Error("图片加载失败"));
        image.src = src;
    });
}

// 先试 CORS 加载，失败再退普通加载（外链最常见的兼容路径）。
async function loadImageRobust(src) {
    try { return await loadImage(src, true); }
    catch (_error) { return loadImage(src, false); }
}

// 跨域外链图片会让 <canvas> 被污染，toDataURL 抛 SecurityError。
// 给出可执行的建议，而不是抛一句看不懂的英文。
function explainCanvasError(error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (/tainted|securityerror|cross-origin/i.test(msg)) {
        return "图片来自跨域外链，浏览器禁止导出被污染的画布。建议：把该图在画布里另存/上传一次（变成同源 blob），或用「导入图片」选本地文件。";
    }
    return msg;
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
    const { image, width, height } = await loadImageRobust(src);
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
        const { image, width, height } = await loadImageRobust(item.src);
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

// ────────────────────────────────────────────────────────────
// 标注 / 涂鸦引擎
// 所有几何量都用 0..1 归一化坐标，导出时乘以原图宽高，
// 因此编辑器里的缩放不会导致线条偏移或粗细失真。
// shape: { kind:"pen", color, width, points:[{x,y}] }
//      | { kind:"arrow"|"rect", color, width, from:{x,y}, to:{x,y} }
// label: { x, y, text, color, fontSize, bg }
// ────────────────────────────────────────────────────────────
function arrowHead(g, fromX, fromY, toX, toY, size) {
    const angle = Math.atan2(toY - fromY, toX - fromX);
    g.beginPath();
    g.moveTo(toX, toY);
    g.lineTo(toX - size * Math.cos(angle - Math.PI / 6), toY - size * Math.sin(angle - Math.PI / 6));
    g.lineTo(toX - size * Math.cos(angle + Math.PI / 6), toY - size * Math.sin(angle + Math.PI / 6));
    g.closePath();
    g.fill();
}

function paintAnnotations(g, w, h, shapes, labels, draft) {
    const allShapes = draft ? [...shapes, draft] : shapes;
    for (const shape of allShapes) {
        if (!shape) continue;
        const lw = Math.max(1, (shape.width || 0.004) * w);
        g.save();
        g.strokeStyle = shape.color || "#ff3b30";
        g.fillStyle = shape.color || "#ff3b30";
        g.lineWidth = lw;
        g.lineCap = "round";
        g.lineJoin = "round";
        if (shape.kind === "pen" && shape.points?.length) {
            g.beginPath();
            shape.points.forEach((p, i) => {
                const px = p.x * w, py = p.y * h;
                if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
            });
            if (shape.points.length === 1) {
                g.lineTo(shape.points[0].x * w + 0.1, shape.points[0].y * h);
            }
            g.stroke();
        } else if ((shape.kind === "arrow" || shape.kind === "rect") && shape.from && shape.to) {
            const x1 = shape.from.x * w, y1 = shape.from.y * h;
            const x2 = shape.to.x * w, y2 = shape.to.y * h;
            if (shape.kind === "rect") {
                g.strokeRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
            } else {
                g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
                arrowHead(g, x1, y1, x2, y2, Math.max(10, lw * 3.5));
            }
        }
        g.restore();
    }

    for (const label of labels) {
        const fs = Math.max(8, (label.fontSize || 0.03) * w);
        const lines = String(label.text || "").split("\n");
        g.save();
        g.font = `600 ${fs}px system-ui, sans-serif`;
        g.textBaseline = "top";
        const lineH = fs * 1.3;
        let maxW = 0;
        for (const line of lines) maxW = Math.max(maxW, g.measureText(line).width);
        const padX = fs * 0.35, padY = fs * 0.22;
        const bx = label.x * w, by = label.y * h;
        if (label.bg !== false) {
            g.fillStyle = "rgba(0,0,0,0.62)";
            g.fillRect(bx - padX, by - padY, maxW + padX * 2, lines.length * lineH + padY * 2);
        }
        g.fillStyle = label.color || "#ff3b30";
        lines.forEach((line, i) => g.fillText(line, bx, by + i * lineH));
        g.restore();
    }
}

// 生成最终 PNG（原图分辨率，不压缩）。
async function renderAnnotated(src, shapes, labels) {
    const { image, width, height } = await loadImageRobust(src);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const g = canvas.getContext("2d");
    g.drawImage(image, 0, 0, width, height);
    paintAnnotations(g, width, height, shapes, labels, null);
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

    // 上游诊断 + 手动重扫
    const [upstreamInfo, setUpstreamInfo] = React.useState({ total: 0, ok: 0, details: [] });
    const [showDiagnostics, setShowDiagnostics] = React.useState(false);
    const [scanTick, setScanTick] = React.useState(0);

    // 标注 / 涂鸦
    const [editorOpen, setEditorOpen] = React.useState(false);
    const [strokes, setStrokes] = React.useState([]);      // [{ color, width, points:[{x,y}] }] 归一化 0..1
    const [labels, setLabels] = React.useState([]);        // [{ x, y, text, color, fontSize, bg }] 归一化 0..1
    const [annotTool, setAnnotTool] = React.useState("pen"); // pen | eraser | text | arrow | rect
    const [annotColor, setAnnotColor] = React.useState("#ff3b30");
    const [annotWidth, setAnnotWidth] = React.useState(4);
    const [annotFontSize, setAnnotFontSize] = React.useState(24);
    const [annotTextBg, setAnnotTextBg] = React.useState(true);
    const [annotPreview, setAnnotPreview] = React.useState(null);
    const [annotSourceKey, setAnnotSourceKey] = React.useState(null); // null = 跟随第一张上游图
    const [pendingLabel, setPendingLabel] = React.useState(null); // 待输入文字的位置
    const [labelDraft, setLabelDraft] = React.useState("");
    const annotateCanvasRef = React.useRef(null);   // 指向原生编辑器里的 <canvas>
    const annotateDrawingRef = React.useRef(null);
    const annotateImageRef = React.useRef(null);
    const editorApiRef = React.useRef(null);        // 原生浮层句柄
    const annotStateRef = React.useRef(null);       // 把最新 state 递给原生事件
    const liveRef = React.useRef(null);             // 把最新回调递给原生事件

    const ctxRef = React.useRef(ctx);
    ctxRef.current = ctx;
    const fileInputRef = React.useRef(null);
    const canvasRef = React.useRef(null);
    const drawingRef = React.useRef(null); // 拖拽中 { startX, startY } 相对图片坐标

    // 上游签名包含地址内容，豆包重新生成后地址变了就会自动重扫（旧版只比 id，不会刷新）。
    const upstreamSignature = JSON.stringify(
        buildImageSources(ctxRef.current).map((s) => `${s.id}|${s.src.length}|${s.src.slice(0, 140)}`),
    );

    // 从上游自动识别图片源：第一张作为「拆分 / 标注」源图，全部进入「合并」列表。
    React.useEffect(() => {
        const sources = buildImageSources(ctxRef.current);
        if (!sources.length) {
            setUpstreamInfo({ total: 0, ok: 0, details: [] });
            return undefined;
        }
        let cancelled = false;
        void (async () => {
            const resolvedItems = [];
            const details = [];
            // 逐张容错：一张豆包外链加载失败，不能让整批图片全部消失。
            for (const s of sources) {
                try {
                    const resolved = await resolveImageSource(s.src, s.storageKey);
                    if (!resolved) throw new Error("地址为空");
                    const { width, height } = await loadImageRobust(resolved);
                    resolvedItems.push({
                        key: `up-${s.id}`, src: s.src, resolvedSrc: resolved, caption: "",
                        name: s.name, width, height,
                    });
                    details.push({ ok: true, name: s.name, type: s.nodeType, from: s.sourceLabel, src: s.src });
                } catch (error) {
                    details.push({
                        ok: false, name: s.name, type: s.nodeType, from: s.sourceLabel, src: s.src,
                        error: error instanceof Error ? error.message : String(error),
                    });
                }
            }
            if (cancelled) return;
            setUpstreamInfo({ total: sources.length, ok: resolvedItems.length, details });

            if (resolvedItems.length) {
                // 合并列表 = 识别成功的上游图（替换旧上游项，保留本地导入项）。
                setMergeItems((prev) => {
                    const localItems = prev.filter((it) => it.key.startsWith("local-"));
                    return [...resolvedItems, ...localItems];
                });
                const f = resolvedItems[0];
                setImageSrc(f.src);
                setResolvedSrc(f.resolvedSrc);
                setImageName(f.name);
                setImgMeta({ width: f.width, height: f.height });
                annotateImageRef.current = null; // 源图变了，标注层缓存失效
                setStatus("");
            } else {
                setStatus(`已找到 ${sources.length} 个上游图片地址，但都无法加载（点「上游诊断」查看原因）`);
            }
        })();
        return () => { cancelled = true; };
    }, [upstreamSignature, scanTick]);

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
            setStatus(`拆分失败：${explainCanvasError(error)}`);
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
            setStatus(`合并失败：${explainCanvasError(error)}`);
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

    // ────────────────────────────────────────────────
    // 标注 / 涂鸦编辑器
    // ────────────────────────────────────────────────
    const annotSource = mergeItems.find((it) => it.key === annotSourceKey)
        || mergeItems[0]
        || (resolvedSrc ? { key: "__current", resolvedSrc, name: imageName || "当前图片" } : null);

    const redrawAnnotate = () => {
        const cv = annotateCanvasRef.current;
        if (!cv) return;
        const g = cv.getContext("2d");
        g.clearRect(0, 0, cv.width, cv.height);
        const img = annotateImageRef.current;
        if (img) g.drawImage(img, 0, 0, cv.width, cv.height);
        paintAnnotations(g, cv.width, cv.height, strokes, labels, annotateDrawingRef.current?.draft || null);
    };

    // 打开编辑器时挂原生浮层到 document.body，绕开宿主画布的 transform。
    // 原生事件通过 liveRef / annotStateRef 取最新状态，不会拿到创建时的过期闭包。
    React.useEffect(() => {
        if (!editorOpen) return undefined;
        const api = {
            getState: () => annotStateRef.current,
            accent: ctx.theme?.accent || "#4c8dff",
            actions: {
                setAnnotTool, setAnnotColor, setAnnotWidth, setAnnotFontSize, setAnnotTextBg,
                setLabelDraft, setPendingLabel, clearAnnot,
                undoAnnot: () => liveRef.current?.undoAnnot(),
                buildAnnotated: () => liveRef.current?.buildAnnotated(),
                addLabel: () => liveRef.current?.addLabel(),
                closeEditor: () => setEditorOpen(false),
            },
            redraw: () => liveRef.current?.redrawAnnotate(),
            setImageRef: (image) => { annotateImageRef.current = image; },
            onPointerDown: (e) => liveRef.current?.annotPointerDown(e),
            onPointerMove: (e) => liveRef.current?.annotPointerMove(e),
            onPointerUp: (e) => liveRef.current?.annotPointerUp(e),
        };
        const editor = openNativeAnnotateEditor(api);
        editorApiRef.current = editor;
        annotateCanvasRef.current = editor.canvas;
        editor.sync();
        return () => {
            editor.dispose();
            editorApiRef.current = null;
            annotateCanvasRef.current = null;
        };
    }, [editorOpen]);

    // 源图变化 / 编辑器刚打开：按原图比例初始化画布。
    React.useEffect(() => {
        if (!editorOpen || !annotSource?.resolvedSrc) return undefined;
        let cancelled = false;
        void (async () => {
            try {
                const { image, width, height } = await loadImageRobust(annotSource.resolvedSrc);
                if (cancelled || !editorApiRef.current) return;
                editorApiRef.current.setImage(image, width, height);
            } catch (error) {
                setStatus(`标注图片加载失败：${explainCanvasError(error)}`);
            }
        })();
        return () => { cancelled = true; };
    }, [editorOpen, annotSource?.resolvedSrc]);

    // 状态变化 → 同步工具条 + 重绘画布。
    React.useEffect(() => {
        if (editorOpen) editorApiRef.current?.sync();
    }, [editorOpen, strokes, labels, annotTool, annotColor, annotWidth, annotFontSize, annotTextBg, pendingLabel, labelDraft, busy]);

    const annotPoint = (event) => {
        const cv = annotateCanvasRef.current;
        const rect = cv?.getBoundingClientRect();
        if (!rect) return { x: 0, y: 0 };
        return {
            x: Math.min(1, Math.max(0, (event.clientX - rect.left) / Math.max(1, rect.width))),
            y: Math.min(1, Math.max(0, (event.clientY - rect.top) / Math.max(1, rect.height))),
        };
    };

    // 粗细 / 字号都按「当前显示宽度」归一化，保证预览与导出视觉一致。
    const annotScaleBase = () => {
        const rect = annotateCanvasRef.current?.getBoundingClientRect();
        return Math.max(1, rect?.width || 400);
    };

    const eraseAt = (p) => {
        const radius = Math.max(8, Number(annotWidth) * 3) / annotScaleBase();
        setStrokes((prev) => prev.filter((shape) => {
            const pts = shape.kind === "pen" ? shape.points : [shape.from, shape.to];
            return !(pts || []).some((q) => q && Math.hypot(q.x - p.x, q.y - p.y) < radius);
        }));
        setLabels((prev) => prev.filter((l) => Math.hypot(l.x - p.x, l.y - p.y) > radius * 2));
    };

    const annotPointerDown = (event) => {
        event.stopPropagation();
        const p = annotPoint(event);
        event.currentTarget.setPointerCapture?.(event.pointerId);
        if (annotTool === "text") {
            setPendingLabel(p);
            setLabelDraft("");
            return;
        }
        if (annotTool === "eraser") {
            annotateDrawingRef.current = { draft: null, erasing: true };
            eraseAt(p);
            return;
        }
        const width = Math.max(1, Number(annotWidth) || 4) / annotScaleBase();
        const base = { kind: annotTool, color: annotColor, width };
        const draft = annotTool === "pen" ? { ...base, points: [p] } : { ...base, from: p, to: p };
        annotateDrawingRef.current = { draft, erasing: false };
        redrawAnnotate();
    };

    const annotPointerMove = (event) => {
        event.stopPropagation();
        const state = annotateDrawingRef.current;
        if (!state) return;
        const p = annotPoint(event);
        if (state.erasing) { eraseAt(p); return; }
        const d = state.draft;
        if (!d) return;
        if (d.kind === "pen") d.points.push(p); else d.to = p;
        redrawAnnotate();
    };

    const annotPointerUp = (event) => {
        event?.stopPropagation?.();
        const state = annotateDrawingRef.current;
        if (!state) return;
        annotateDrawingRef.current = null;
        const d = state.draft;
        if (d) {
            const valid = d.kind === "pen"
                ? d.points.length > 1
                : Math.hypot(d.to.x - d.from.x, d.to.y - d.from.y) > 0.004;
            if (valid) setStrokes((prev) => [...prev, d]);
        }
        redrawAnnotate();
    };

    const addLabel = () => {
        if (!pendingLabel || !labelDraft.trim()) { setPendingLabel(null); return; }
        const fontSize = Math.max(10, Number(annotFontSize) || 24) / annotScaleBase();
        setLabels((prev) => [...prev, {
            ...pendingLabel, text: labelDraft.trim(), color: annotColor, fontSize, bg: annotTextBg,
        }]);
        setPendingLabel(null);
        setLabelDraft("");
    };

    const undoAnnot = () => {
        if (strokes.length) setStrokes((prev) => prev.slice(0, -1));
        else if (labels.length) setLabels((prev) => prev.slice(0, -1));
    };
    const clearAnnot = () => { setStrokes([]); setLabels([]); setAnnotPreview(null); };

    const buildAnnotated = async () => {
        if (!annotSource?.resolvedSrc) { setStatus("请先导入或连接图片"); return; }
        setBusy(true);
        setStatus("");
        try {
            const dataUrl = await renderAnnotated(annotSource.resolvedSrc, strokes, labels);
            const base = String(annotSource.name || "标注图").replace(/\.[^.]+$/, "");
            setAnnotPreview({ dataUrl, fileName: `${base}-标注.png` });
        } catch (error) {
            setStatus(`标注图生成失败：${explainCanvasError(error)}`);
        } finally {
            setBusy(false);
        }
    };

    const exportAnnotated = async () => {
        if (!annotPreview) { setStatus("请先生成标注图"); return; }
        setBusy(true);
        try {
            await sendImages(ctxRef.current, [annotPreview]);
            setStatus("已回传标注图到画布");
        } catch (error) {
            setStatus(`回传失败：${explainCanvasError(error)}`);
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

    const smallButton = (label, onClick) =>
        h("button", { type: "button", style: { ...buttonStyle, padding: "3px 8px", fontSize: 11 }, onClick }, label);

    const shortSrc = (s) => {
        const v = String(s || "");
        if (v.startsWith("data:")) return `data:image/…（${v.length} 字符）`;
        return v.length > 88 ? `${v.slice(0, 62)}…${v.slice(-14)}` : v;
    };

    const diagnosticsUI = h("div", { style: { marginTop: 6, borderTop: `1px dashed ${stroke}`, paddingTop: 6 } },
        h("div", { style: { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" } },
            h("span", { style: { fontSize: 11, color: muted } }, `上游识别：${upstreamInfo.ok}/${upstreamInfo.total} 张可用`),
            smallButton("重新扫描", () => setScanTick((t) => t + 1)),
            smallButton(showDiagnostics ? "收起详情" : "上游诊断", () => setShowDiagnostics((v) => !v)),
        ),
        showDiagnostics
            ? h("div", { style: { marginTop: 6, maxHeight: 170, overflowY: "auto", fontSize: 10, lineHeight: 1.6, color: muted, background: ctx.theme.toolbar.panel || "transparent", border: `1px solid ${stroke}`, borderRadius: 6, padding: 6 } },
                upstreamInfo.details.length
                    ? upstreamInfo.details.slice(0, 20).map((d, i) =>
                        h("div", { key: i, style: { marginBottom: 4, wordBreak: "break-all" } },
                            `${d.ok ? "✅" : "❌"} [${d.from}] type=${d.type} · ${d.name}`,
                            h("br"),
                            shortSrc(d.src),
                            d.error ? ` ｜ ${d.error}` : "",
                        ),
                    )
                    : "未发现上游图片地址。请确认连线方向（上游 → 本节点），或点「重新扫描」。若豆包节点是批量生成，展开的图片子节点也会被自动扫描。",
            )
            : null,
    );

    // 渲染末尾刷新「给原生浮层用」的最新状态与回调（避免闭包过期）。
    annotStateRef.current = {
        annotTool, annotColor, annotWidth, annotFontSize, annotTextBg,
        strokes, labels, pendingLabel, labelDraft, busy,
    };
    liveRef.current = {
        redrawAnnotate, annotPointerDown, annotPointerMove, annotPointerUp,
        buildAnnotated, undoAnnot, addLabel,
    };

    return h(
        "div",
        { "data-canvas-no-zoom": true, style: { display: "flex", flexDirection: "column", gap: 10, padding: 12, width: "100%", height: "100%", boxSizing: "border-box", overflowY: "auto", color: text, fontSize: 12 } },
        h("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
            h("span", { style: { fontSize: 18 } }, "🧩"),
            h("span", { style: { fontSize: 14, fontWeight: 600 } }, "图片拆分与合并"),
        ),
        // 图片来源
        h("div", null,
            h("div", { style: labelStyle }, "图片来源（自动适配普通图片 / 豆包生图 / 批量生成节点）"),
            h("input", { ref: fileInputRef, type: "file", accept: "image/*", style: { display: "none" }, onChange: handleFile }),
            h("div", { style: { display: "flex", gap: 6, alignItems: "center" } },
                h("button", { type: "button", style: buttonStyle, onClick: () => fileInputRef.current?.click() }, "导入图片"),
                resolvedSrc ? h("span", { style: { fontSize: 11, color: muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, `${imageName || "已加载"} ${imgMeta.width}×${imgMeta.height}`) : h("span", { style: { fontSize: 11, color: muted } }, "也可连接上游图片节点"),
            ),
            diagnosticsUI,
        ),
        // ── 标注 / 涂鸦 ──
        h("div", { style: { borderTop: `1px solid ${stroke}`, paddingTop: 10 } },
            h("div", { style: { fontSize: 13, fontWeight: 600, marginBottom: 6 } }, "🎨 文字标注 / 涂鸦"),
            h("div", { style: labelStyle }, "选择要标注的图片"),
            h("select", {
                value: annotSource?.key || "",
                style: inputStyle,
                onChange: (e) => setAnnotSourceKey(e.target.value || null),
            },
                mergeItems.length
                    ? mergeItems.map((it, i) => h("option", { key: it.key, value: it.key }, `${i + 1}. ${it.name}`))
                    : resolvedSrc
                        ? h("option", { value: "__current" }, `当前图片 · ${imageName || "已加载"}`)
                        : h("option", { value: "" }, "（暂无图片，请先连接上游或导入）"),
            ),
            h("div", { style: { display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" } },
                h("button", { type: "button", style: primaryStyle, onClick: () => setEditorOpen(true), disabled: !annotSource?.resolvedSrc }, "打开标注编辑器"),
                h("span", { style: { fontSize: 11, color: muted, alignSelf: "center" } }, `${strokes.length} 笔 · ${labels.length} 处文字`),
                (strokes.length || labels.length) ? smallButton("清空标注", clearAnnot) : null,
            ),
            annotPreview
                ? h("div", { style: { marginTop: 8 } },
                    h("img", { src: annotPreview.dataUrl, alt: "标注结果", style: { width: "100%", maxHeight: 220, objectFit: "contain", borderRadius: 8, display: "block", background: "#000" } }),
                    h("button", { type: "button", style: { ...primaryStyle, marginTop: 6 }, onClick: exportAnnotated, disabled: busy }, "回传标注图到画布"),
                )
                : null,
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
        status ? h("div", { style: { color: "#ef9a9a", fontSize: 11, whiteSpace: "pre-wrap" } }, status) : null,
    );
}

// 供 test-upstream.mjs 做纯逻辑回归测试；宿主只消费 default export，这些额外导出无副作用。
export { buildImageSources, extractNodeUrls, looksLikeImageUrl, normalizeUpstream, expandUpstream, paintAnnotations };

export default function createImageSplitMergePlugin(runtime) {
    const React = runtime.React;
    return {
        id: "image-split-merge",
        name: "图片拆分与合并",
        version: "0.3.0",
        minAppVersion: "0.12.0",
        description: "图片拆分（网格/图框）、合并（拼接+图号+批注）、文字标注与涂鸦画笔；自动适配豆包生图等自定义上游节点。",
        nodes: [
            {
                type: "image:split-merge",
                title: "图片拆分与合并",
                icon: "🧩",
                description: "拆分 / 合并 / 文字标注与涂鸦，支持豆包生图上游节点",
                defaultSize: { width: 400, height: 820 },
                defaultMetadata: {},
                hasSourceHandle: true,
                hidePanel: true,
                Content: (props) => ImageSplitMergeContent({ ...props, React }),
            },
        ],
    };
}
