import type { Root, RootContent } from 'mdast'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

function remarkCitations({ labels }: { labels: string[] }) {
  const allowed = new Set(labels)
  return (tree: Root) => {
    function transform(nodes: RootContent[]): RootContent[] {
      return nodes.flatMap((node) => {
        if (node.type === 'text') {
          return [...node.value.matchAll(/\[S\d+\]|[^[]+|\[/g)].map((match): RootContent => {
            const label = match[0].slice(1, -1)
            return /^\[S\d+\]$/.test(match[0]) && allowed.has(label)
              ? { type: 'link', url: `#source-${label}`, children: [{ type: 'text', value: match[0] }] }
              : { type: 'text', value: match[0] }
          })
        }
        // 仅转换普通文本，保留代码块、行内代码和已有链接的原始语义。
        if ('children' in node && node.type !== 'link' && node.type !== 'linkReference')
          node.children = transform(node.children) as typeof node.children
        return [node]
      })
    }
    tree.children = transform(tree.children) as Root['children']
  }
}

export function AnswerMarkdown({ text, labels }: { text: string, labels: string[] }) {
  return (
    <div className="answer-text">
      <Markdown
        skipHtml
        remarkPlugins={[remarkGfm, [remarkCitations, { labels }]]}
        components={{
          a: ({ href, children }) => {
            const citation = href?.startsWith('#source-') && labels.includes(href.slice(8))
            return (
              <a
                href={href}
                className={citation ? 'citation' : undefined}
                target={citation ? undefined : '_blank'}
                rel={citation ? undefined : 'noopener noreferrer'}
                onClick={citation
                  ? () => {
                      const element = document.getElementById((href ?? '').slice(1))
                      if (element instanceof HTMLDetailsElement) {
                        element.open = true
                        element.focus()
                      }
                    }
                  : undefined}
              >
                {children}
              </a>
            )
          },
          img: ({ alt }) => <span className="field-hint">{alt ? `[图片：${alt}]` : '[图片]'}</span>,
        }}
      >
        {text}
      </Markdown>
    </div>
  )
}
