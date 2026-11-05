import { build } from "esbuild";

await build({
    entryPoints: ["src/image-split-merge.js"],
    outfile: "dist/image-split-merge.js",
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2020",
    minify: true,
    legalComments: "eof",
});

console.log("built dist/image-split-merge.js");
