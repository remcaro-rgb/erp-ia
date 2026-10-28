import type { Block, Inline } from "./model";
import { parseRichText } from "./model";

export interface RichTextProps {
  text: string;
  /** Follows a link of the app through the shell's router. */
  onNavigate?: (href: string) => void;
}

function Inlines({ nodes, onNavigate }: { nodes: Inline[]; onNavigate?: ((href: string) => void) | undefined }) {
  return (
    <>
      {nodes.map((node, i) => {
        switch (node.type) {
          case "text":
            return node.text;
          case "strong":
            return <strong key={i}>{node.text}</strong>;
          case "code":
            return <code key={i}>{node.text}</code>;
          case "link":
            return (
              <a
                key={i}
                href={node.href}
                onClick={(event) => {
                  if (!onNavigate || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                  event.preventDefault();
                  onNavigate(node.href);
                }}
              >
                {node.text}
              </a>
            );
        }
      })}
    </>
  );
}

/**
 * The model's text (rule 17, Task 17 prompt-injection mitigation): paragraphs, bullets, bold, code and links to the
 * app's own routes, built as React elements from a parsed tree. No HTML is interpreted, no image is ever loaded and no
 * link leaves the app.
 */
export function RichText({ text, onNavigate }: RichTextProps) {
  const blocks: Block[] = parseRichText(text);
  return (
    <>
      {blocks.map((block, i) =>
        block.type === "p" ? (
          <p key={i}>
            <Inlines nodes={block.children} onNavigate={onNavigate} />
          </p>
        ) : (
          <ul key={i}>
            {block.items.map((item, j) => (
              <li key={j}>
                <Inlines nodes={item} onNavigate={onNavigate} />
              </li>
            ))}
          </ul>
        ),
      )}
    </>
  );
}
