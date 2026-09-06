const calloutPattern = /^\[!([\w-]+)\]([+-])?\s*(.*)$/i
const highlightPattern = /==([^=\n]+)==/g

function walk(node, visitor) {
  visitor(node)
  if (Array.isArray(node.children)) {
    for (const child of node.children) walk(child, visitor)
  }
}

function addHighlights(node) {
  if (!Array.isArray(node.children)) return

  node.children = node.children.flatMap((child) => {
    if (child.type !== "text" || !child.value.includes("==")) {
      addHighlights(child)
      return child
    }

    const result = []
    let cursor = 0
    for (const match of child.value.matchAll(highlightPattern)) {
      if (match.index > cursor) {
        result.push({ type: "text", value: child.value.slice(cursor, match.index) })
      }
      result.push({
        type: "text",
        value: match[1],
        data: { hName: "mark" },
      })
      cursor = match.index + match[0].length
    }
    if (cursor < child.value.length) {
      result.push({ type: "text", value: child.value.slice(cursor) })
    }
    return result.length ? result : child
  })
}

function headingText(node) {
  let text = ""
  walk(node, (child) => {
    if (child.type === "text") text += child.value
  })
  return text.trim()
}

export function remarkDropDuplicateTitle() {
  return (tree, file) => {
    const title = file.data?.astro?.frontmatter?.title
    if (!title || !Array.isArray(tree.children)) return

    const index = tree.children.findIndex((node) => node.type === "heading" && node.depth === 1)
    if (index === -1) return
    if (headingText(tree.children[index]) === String(title).trim()) {
      tree.children.splice(index, 1)
    }
  }
}

export function rehypeImages() {
  return (tree) => {
    walk(tree, (node) => {
      if (node.type !== "element" || node.tagName !== "img") return
      node.properties = {
        ...(node.properties || {}),
        loading: "lazy",
        decoding: "async",
      }
    })
  }
}

export default function remarkCallouts() {
  return (tree) => {
    walk(tree, (node) => {
      // Obsidian chart blocks remain readable as highlighted YAML when a chart
      // renderer is intentionally not shipped with the core blog.
      if (node.type === "code" && node.lang === "chart") {
        node.lang = "yaml"
        return
      }

      if (node.type !== "blockquote") return
      const firstParagraph = node.children?.[0]
      const firstText = firstParagraph?.children?.[0]
      if (firstParagraph?.type !== "paragraph" || firstText?.type !== "text") return

      const match = firstText.value.match(calloutPattern)
      if (!match) return

      const [, type, fold, leftover] = match
      firstText.value = leftover
      if (!firstText.value) firstParagraph.children.shift()

      const titleFromStrong = firstParagraph.children[0]?.type === "strong"
      if (titleFromStrong) {
        const titleNode = firstParagraph.children.shift()
        if (firstParagraph.children[0]?.type === "break") firstParagraph.children.shift()
        if (firstParagraph.children[0]?.type === "text") {
          firstParagraph.children[0].value = firstParagraph.children[0].value.replace(/^\n+/, "")
          if (!firstParagraph.children[0].value) firstParagraph.children.shift()
        }
        node.children.unshift({
          type: "paragraph",
          children: [titleNode],
          data: { hProperties: { className: ["callout-title"] } },
        })
      } else if (firstParagraph.children.length) {
        firstParagraph.data = {
          ...(firstParagraph.data || {}),
          hProperties: {
            ...(firstParagraph.data?.hProperties || {}),
            className: ["callout-title"],
          },
        }
      } else {
        node.children.shift()
      }

      node.data = {
        ...(node.data || {}),
        hProperties: {
          ...(node.data?.hProperties || {}),
          className: ["callout", `callout-${type.toLowerCase()}`],
          ...(fold ? { "data-fold": fold } : {}),
        },
      }
    })

    addHighlights(tree)
  }
}
