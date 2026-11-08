// 上游适配层回归测试：node test-upstream.mjs
// 用模拟的宿主 ctx 覆盖「普通图片 / 豆包自定义节点 / 批量生成 / 间接上游」等结构。

import { buildImageSources, extractNodeUrls, looksLikeImageUrl } from "./src/image-split-merge.js";

let passed = 0;
let failed = 0;
function check(name, condition, extra = "") {
    if (condition) { passed++; console.log(`✅ ${name}`); }
    else { failed++; console.log(`❌ ${name} ${extra}`); }
}

function makeCtx(nodes, connections, upstreamIds) {
    return {
        node: { id: "self", position: { x: 0, y: 0 }, width: 400, height: 820 },
        getUpstream: () => upstreamIds.map((id) => nodes.find((n) => n.id === id)).filter(Boolean),
        getNodes: () => nodes,
        getConnections: () => connections,
        getTheme: () => ({}),
    };
}

const URL_A = "https://p3-byteimg.tos-cn-beijing.volces.com/doubao/abc123.png";
const URL_B = "https://cdn.example.com/seedream/out?image_url=1";
const URL_C = "data:image/png;base64,iVBORw0KGgo=";

// 1) 普通图片节点（旧逻辑也能过）
{
    const nodes = [{ id: "img1", type: "image", title: "普通图", metadata: { content: URL_A } }];
    const sources = buildImageSources(makeCtx(nodes, [{ fromNodeId: "img1", toNodeId: "self" }], ["img1"]));
    check("普通 image 节点 content", sources.length === 1 && sources[0].src === URL_A);
}

// 2) 豆包自定义类型节点（旧逻辑挂在这里）
{
    const nodes = [{ id: "db1", type: "hushifu:doubao-image", title: "豆包生图", metadata: { content: URL_A, mimeType: "image/png" } }];
    const sources = buildImageSources(makeCtx(nodes, [], ["db1"]));
    check("自定义 type 的豆包节点", sources.length === 1, JSON.stringify(sources));
}

// 3) 地址放在 images 数组里，不在 content
{
    const nodes = [{
        id: "db2", type: "doubao", title: "豆包批量",
        metadata: { images: [{ url: URL_A }, { url: URL_C }], status: "success" },
    }];
    const sources = buildImageSources(makeCtx(nodes, [], ["db2"]));
    check("images[] 对象数组", sources.length === 2, JSON.stringify(sources.map((s) => s.src)));
}

// 4) 批量生成根节点：主图 + batchChildIds 子图
{
    const nodes = [
        { id: "root", type: "image", title: "批量根", metadata: { content: URL_A, isBatchRoot: true, batchChildIds: ["c1", "c2"] } },
        { id: "c1", type: "image", title: "子图1", metadata: { content: URL_B, batchRootId: "root" } },
        { id: "c2", type: "image", title: "子图2", metadata: { content: URL_C, batchRootId: "root" } },
    ];
    const sources = buildImageSources(makeCtx(nodes, [], ["root"]));
    check("批量节点展开 3 张", sources.length === 3, `实际 ${sources.length}`);
    check("批量子图带来源标签", sources.some((s) => s.sourceLabel.includes("批量子图")));
}

// 5) 间接上游：豆包节点 → 中间节点 → 本节点
{
    const nodes = [
        { id: "db3", type: "hushifu:doubao", title: "豆包", metadata: { content: URL_A } },
        { id: "mid", type: "text", title: "提示词", metadata: { content: "一只猫" } },
    ];
    const connections = [
        { fromNodeId: "db3", toNodeId: "mid" },
        { fromNodeId: "mid", toNodeId: "self" },
    ];
    const sources = buildImageSources(makeCtx(nodes, connections, ["mid"]));
    check("间接上游穿透 2 层", sources.some((s) => s.src === URL_A), JSON.stringify(sources));
}

// 6) 文本节点不能被误收
{
    const nodes = [{ id: "t1", type: "text", title: "提示词", metadata: { content: "参考 https://example.com/photo.png 的构图" } }];
    const sources = buildImageSources(makeCtx(nodes, [], ["t1"]));
    check("文本节点不误收为图片", sources.length === 0, JSON.stringify(sources));
}

// 7) 去重：同一地址出现在多个字段
{
    const nodes = [{ id: "d1", type: "image", title: "重复", metadata: { content: URL_A, imageUrl: URL_A, url: URL_A } }];
    const sources = buildImageSources(makeCtx(nodes, [], ["d1"]));
    check("同地址去重", sources.length === 1, `实际 ${sources.length}`);
}

// 8) 只有 storageKey 时走宿主通道
{
    const urls = extractNodeUrls({ id: "s1", type: "image", metadata: { storageKey: "img-files/abc.png" } });
    check("storageKey 兜底", urls.length === 1 && urls[0] === "canvas-storage://img-files/abc.png", JSON.stringify(urls));
}

// 9) URL 特征判定
{
    check("豆包外链识别", looksLikeImageUrl(URL_A));
    check("无扩展名图片语义 URL", looksLikeImageUrl(URL_B));
    check("dataURL 识别", looksLikeImageUrl(URL_C));
    check("普通网页不误判", !looksLikeImageUrl("https://example.com/article/123"));
}

// 10) 真实尺寸的长 base64（画布保存的图片通常是几 MB 的 dataURL）
{
    const longData = `data:image/png;base64,${"A".repeat(1_500_000)}`;
    check("超长 dataURL 不被长度上限误杀", looksLikeImageUrl(longData));
    const nodes = [{ id: "big", type: "image", title: "长图", metadata: { content: longData } }];
    const sources = buildImageSources(makeCtx(nodes, [], ["big"]));
    check("长 dataURL 能从节点提取", sources.length === 1 && sources[0].src === longData);
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
if (failed) process.exit(1);
