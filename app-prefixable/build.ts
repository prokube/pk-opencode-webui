import esbuild from "esbuild"
import { solidPlugin } from "esbuild-plugin-solid"
import postcss from "postcss"
import tailwindcss from "tailwindcss"
import autoprefixer from "autoprefixer"

console.log("Building for runtime prefix detection...")

// Build CSS with Tailwind
console.log("Building CSS...")
const cssSource = await Bun.file("./src/index.css").text()
const cssResult = await postcss([tailwindcss("./tailwind.config.js"), autoprefixer()]).process(cssSource, {
  from: "./src/index.css",
  to: "./dist/styles.css",
})
await Bun.write("./dist/styles.css", cssResult.css)
console.log("CSS built")

// Build JS with esbuild
// Use relative paths (./) so assets work with any prefix at runtime
console.log("Building JS...")
const result = await esbuild.build({
  entryPoints: ["./src/entry.tsx"],
  outdir: "./dist",
  publicPath: "./", // Relative paths - works with any prefix!
  bundle: true,
  minify: process.env.NODE_ENV === "production",
  splitting: true,
  format: "esm",
  sourcemap: true,
  target: "esnext",
  plugins: [solidPlugin()],
  metafile: true,
})

console.log(`JS build completed: ${Object.keys(result.metafile?.outputs || {}).length} files`)

// Copy index.html to dist
const html = await Bun.file("./src/index.html").text()
await Bun.write("./dist/index.html", html)

// Copy public assets if they exist
try {
  const { $ } = await import("bun")
  await $`cp -r ./public/* ./dist/ 2>/dev/null`.quiet()
} catch {
  // public folder may be empty, ignore
}

console.log("Done!")
