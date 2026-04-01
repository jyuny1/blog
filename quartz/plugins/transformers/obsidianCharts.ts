import { QuartzTransformerPlugin } from "../types"
import { CSSResource, JSResource } from "../../util/resources"
// @ts-ignore
import chartScript from "../../components/scripts/obsidianCharts.inline"
// @ts-ignore
import chartStyle from "../../components/styles/obsidianCharts.inline.scss"

type ChartSeries = {
  title?: string
  color?: string
  data: number[]
}

type ChartBlock = {
  type: string
  labels: Array<string | number>
  series: ChartSeries[]
  yTitle?: string
  xTitle?: string
  legendPosition?: string
  tension?: number
  fill?: boolean
  beginAtZero?: boolean
}

function parseScalar(value: string): string | number | boolean {
  const trimmed = value.trim()
  if (!trimmed) {
    return ""
  }

  if (
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))) &&
    trimmed.length >= 2
  ) {
    return trimmed.slice(1, -1)
  }

  if (trimmed === "true") {
    return true
  }
  if (trimmed === "false") {
    return false
  }
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return Number(trimmed)
  }

  return trimmed
}

function parseChartBlock(raw: string): ChartBlock | null {
  const topLevel: Record<string, string | number | boolean> = {}
  for (const line of raw.split("\n")) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9]*):\s*(.*)$/)
    if (!match) {
      continue
    }

    const [, key, value] = match
    if (key === "labels" || key === "series") {
      continue
    }
    topLevel[key] = parseScalar(value)
  }

  const labelsMatch = raw.match(/(?:^|\n)labels:\n((?:  - .*(?:\n|$))+)/)
  const labels = labelsMatch
    ? labelsMatch[1]
        .trimEnd()
        .split("\n")
        .map((line) => parseScalar(line.replace(/^  - /, "")))
    : []

  const seriesMatch = raw.match(/(?:^|\n)series:\n([\s\S]*?)(?=\n[A-Za-z][A-Za-z0-9]*:|\s*$)/)
  const seriesBlock = seriesMatch ? seriesMatch[1].trimEnd() : ""
  const series = (seriesBlock ? seriesBlock.split(/\n(?=  - )/) : []).map((item) => {
    const title = item.match(/^  - title:\s*(.*)$/m)
    const color = item.match(/^    color:\s*(.*)$/m)
    const dataMatch = item.match(/^    data:\n((?:      - .*(?:\n|$))+)/m)
    const data = dataMatch
      ? dataMatch[1]
          .trimEnd()
          .split("\n")
          .map((line) => Number(parseScalar(line.replace(/^      - /, ""))))
      : []

    return {
      title: title ? String(parseScalar(title[1])) : undefined,
      color: color ? String(parseScalar(color[1])) : undefined,
      data,
    }
  })

  const type = typeof topLevel.type === "string" ? topLevel.type : "line"
  if ((type !== "line" && type !== "bar") || labels.length === 0 || series.length === 0) {
    return null
  }

  return {
    type,
    labels,
    series,
    yTitle: typeof topLevel.yTitle === "string" ? topLevel.yTitle : undefined,
    xTitle: typeof topLevel.xTitle === "string" ? topLevel.xTitle : undefined,
    legendPosition:
      typeof topLevel.legendPosition === "string" ? topLevel.legendPosition : undefined,
    tension: typeof topLevel.tension === "number" ? topLevel.tension : undefined,
    fill: typeof topLevel.fill === "boolean" ? topLevel.fill : undefined,
    beginAtZero: typeof topLevel.beginAtZero === "boolean" ? topLevel.beginAtZero : undefined,
  }
}

function renderChartPlaceholder(block: ChartBlock) {
  const encoded = encodeURIComponent(JSON.stringify(block))
  return `<div class="obsidian-chart" data-chart="${encoded}"><canvas></canvas></div>`
}

export const ObsidianCharts: QuartzTransformerPlugin = () => {
  return {
    name: "ObsidianCharts",
    textTransform(_ctx, src) {
      return src.replace(/```chart\s*\n([\s\S]*?)\n```/g, (full, raw) => {
        const parsed = parseChartBlock(raw)
        return parsed ? renderChartPlaceholder(parsed) : full
      })
    },
    externalResources() {
      const js: JSResource[] = [
        {
          loadTime: "afterDOMReady",
          contentType: "external",
          src: "https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.min.js",
          spaPreserve: true,
        },
        {
          loadTime: "afterDOMReady",
          contentType: "inline",
          script: chartScript,
          spaPreserve: true,
        },
      ]
      const css: CSSResource[] = [
        {
          content: chartStyle,
          inline: true,
          spaPreserve: true,
        },
      ]
      return { js, css }
    },
  }
}
