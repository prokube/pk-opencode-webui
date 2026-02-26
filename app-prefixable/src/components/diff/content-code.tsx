import { codeToHtml, bundledLanguages } from "shiki";
import { createSignal, createEffect, Show } from "solid-js";
import { transformerNotationDiff } from "@shikijs/transformers";
import "./content-code.css";

// Cache for highlighted code to prevent re-highlighting on re-renders
const highlightCache = new Map<string, string>();

async function highlight(code: string, lang?: string): Promise<string> {
  const key = `${lang ?? "text"}:${code}`;
  const cached = highlightCache.get(key);
  if (cached) return cached;

  const html = await codeToHtml(code || "", {
    lang: lang && lang in bundledLanguages ? lang : "text",
    themes: {
      light: "github-light",
      dark: "github-dark",
    },
    transformers: [transformerNotationDiff()],
  });

  highlightCache.set(key, html);
  return html;
}

interface Props {
  code: string;
  lang?: string;
  flush?: boolean;
}

export function ContentCode(props: Props) {
  const cacheKey = () => `${props.lang ?? "text"}:${props.code}`;

  // Initialize with cached value if available
  const [html, setHtml] = createSignal(highlightCache.get(cacheKey()) ?? "");

  // Effect runs when code/lang changes
  createEffect(() => {
    const key = cacheKey();
    const cached = highlightCache.get(key);

    if (cached) {
      // Already cached - use immediately
      setHtml(cached);
    } else {
      // Need to highlight - clear current and fetch
      setHtml("");
      highlight(props.code, props.lang).then((result) => {
        // Only update if still the same key
        if (cacheKey() === key) {
          setHtml(result);
        }
      });
    }
  });

  return (
    <Show
      when={html()}
      fallback={
        <pre
          class="content-code"
          data-flush={props.flush === true ? true : undefined}
        >
          {props.code}
        </pre>
      }
    >
      <div
        innerHTML={html()}
        class="content-code"
        data-flush={props.flush === true ? true : undefined}
      />
    </Show>
  );
}
