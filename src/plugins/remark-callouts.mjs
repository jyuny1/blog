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

const BR_REGEX = /<br\s*\/?>/i
const BR_SPLIT_REGEX = /(<br\s*\/?>)/i
const LIST_ITEM_PREFIX = /^-[ \u00a0]/

function isBrNode(node) {
  if (!node) return false
  if (node.type === "element" && node.tagName?.toLowerCase() === "br") return true
  if ((node.type === "raw" || node.type === "text") && /^\s*<br\s*\/?>\s*$/i.test(node.value)) return true
  return false
}

function flattenCellChildren(children) {
  const result = []
  for (const child of children) {
    if ((child.type === "text" || child.type === "raw") && BR_REGEX.test(child.value)) {
      const parts = child.value.split(BR_SPLIT_REGEX)
      for (const part of parts) {
        if (!part) continue
        if (/^<br\s*\/?>$/i.test(part)) {
          result.push({ type: "element", tagName: "br", properties: {}, children: [] })
        } else if (child.type === "raw" && !part.includes("<")) {
          result.push({ type: "text", value: part })
        } else {
          result.push({ ...child, value: part })
        }
      }
    } else {
      result.push(child)
    }
  }
  return result
}

function getFirstContentNode(line) {
  for (const node of line) {
    if (node.type === "text" && /^\s*$/.test(node.value)) continue
    return node
  }
  return null
}

function isListItem(line) {
  const firstNode = getFirstContentNode(line)
  if (!firstNode || firstNode.type !== "text") return false
  return LIST_ITEM_PREFIX.test(firstNode.value.trimStart())
}

function isWhitespaceOnlyText(node) {
  return node && node.type === "text" && /^\s*$/.test(node.value)
}

function processLiChildren(line) {
  const children = line.map((node) => ({ ...node }))
  const firstTextNode = getFirstContentNode(children)
  if (firstTextNode && firstTextNode.type === "text") {
    firstTextNode.value = firstTextNode.value.replace(/^\s*-[ \u00a0]/, "")
  }
  while (children.length > 0 && isWhitespaceOnlyText(children[0])) {
    children.shift()
  }
  while (children.length > 0 && isWhitespaceOnlyText(children[children.length - 1])) {
    children.pop()
  }
  return children
}

function processTableCell(node) {
  if (!Array.isArray(node.children)) return
  const flattened = flattenCellChildren(node.children)

  const lines = []
  let currentLine = []
  for (const child of flattened) {
    if (isBrNode(child)) {
      lines.push(currentLine)
      currentLine = []
    } else {
      currentLine.push(child)
    }
  }
  lines.push(currentLine)

  const nonBlankLines = lines.filter((line) => {
    if (line.length === 0) return false
    return !line.every(isWhitespaceOnlyText)
  })

  if (!nonBlankLines.some(isListItem)) return

  const chunks = []
  let currentList = null

  for (const line of nonBlankLines) {
    if (isListItem(line)) {
      if (!currentList) {
        currentList = [];
        chunks.push({ type: "list", items: currentList })
      }
      currentList.push(line)
    } else {
      currentList = null
      chunks.push({ type: "non-list", line })
    }
  }

  const newChildren = []
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]
    if (chunk.type === "list") {
      newChildren.push({
        type: "element",
        tagName: "ul",
        properties: { className: ["cell-list"] },
        children: chunk.items.map((itemLine) => ({
          type: "element",
          tagName: "li",
          properties: {},
          children: processLiChildren(itemLine),
        })),
      })
    } else {
      newChildren.push(...chunk.line)
      if (i + 1 < chunks.length && chunks[i + 1].type === "non-list") {
        newChildren.push({
          type: "element",
          tagName: "br",
          properties: {},
          children: [],
        })
      }
    }
  }

  node.children = newChildren
}

export function rehypeTableLists() {
  return (tree) => {
    walk(tree, (node) => {
      if (node.type === "element" && (node.tagName === "td" || node.tagName === "th")) {
        processTableCell(node)
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
