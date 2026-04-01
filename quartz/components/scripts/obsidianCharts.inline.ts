type ChartConfig = {
  type?: string
  labels?: Array<string | number>
  series?: Array<{
    title?: string
    color?: string
    data?: number[]
  }>
  yTitle?: string
  xTitle?: string
  legendPosition?: "top" | "left" | "bottom" | "right"
  tension?: number
  fill?: boolean
  beginAtZero?: boolean
}

declare global {
  interface Window {
    Chart?: any
  }
}

let chartInstances: any[] = []

function cssVar(name: string) {
  return window.getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

function hexToRgba(color: string, alpha: number) {
  const hex = color.replace("#", "").trim()
  if (hex.length !== 6) {
    return color
  }

  const r = Number.parseInt(hex.slice(0, 2), 16)
  const g = Number.parseInt(hex.slice(2, 4), 16)
  const b = Number.parseInt(hex.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

function chartPalette() {
  return [
    cssVar("--secondary") || "#284b63",
    cssVar("--tertiary") || "#84a59d",
    cssVar("--darkgray") || "#4e4e4e",
    cssVar("--gray") || "#b8b8b8",
  ]
}

function parseChartConfig(el: HTMLElement): ChartConfig | null {
  const raw = el.dataset.chart
  if (!raw) {
    return null
  }

  try {
    return JSON.parse(decodeURIComponent(raw)) as ChartConfig
  } catch {
    return null
  }
}

function destroyCharts() {
  for (const chart of chartInstances) {
    chart.destroy()
  }
  chartInstances = []
}

function buildDatasets(config: ChartConfig) {
  const palette = chartPalette()
  const tension = typeof config.tension === "number" ? config.tension : 0
  const shouldFill = Boolean(config.fill)

  return (config.series ?? []).map((series, index) => {
    const color = series.color || palette[index % palette.length]
    return {
      label: series.title || `Series ${index + 1}`,
      data: series.data ?? [],
      borderColor: color,
      backgroundColor: shouldFill ? hexToRgba(color, 0.18) : color,
      pointBackgroundColor: color,
      pointBorderColor: color,
      borderWidth: 3,
      pointRadius: 2,
      pointHoverRadius: 4,
      tension,
      fill: shouldFill,
    }
  })
}

function renderCharts() {
  if (!window.Chart) {
    return
  }

  destroyCharts()

  const containers = document.querySelectorAll(".obsidian-chart[data-chart]") as NodeListOf<HTMLElement>
  if (containers.length === 0) {
    return
  }

  const textColor = cssVar("--dark") || "#2b2b2b"
  const mutedColor = cssVar("--darkgray") || "#4e4e4e"
  const gridColor = cssVar("--lightgray") || "#e5e5e5"

  for (const el of containers) {
    const config = parseChartConfig(el)
    if (!config) {
      continue
    }

    const canvas = el.querySelector("canvas") as HTMLCanvasElement | null
    if (!canvas) {
      continue
    }

    const datasets = buildDatasets(config)
    const type = config.type === "bar" ? "bar" : "line"

    const chart = new window.Chart(canvas, {
      type,
      data: {
        labels: (config.labels ?? []).map((label) => String(label)),
        datasets,
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: {
          mode: "index",
          intersect: false,
        },
        plugins: {
          legend: {
            display: datasets.length > 1,
            position: config.legendPosition || "bottom",
            labels: {
              color: textColor,
              usePointStyle: true,
              boxWidth: 10,
              boxHeight: 10,
            },
          },
          tooltip: {
            enabled: true,
          },
        },
        scales: {
          x: {
            title: {
              display: Boolean(config.xTitle),
              text: config.xTitle,
              color: textColor,
            },
            ticks: {
              color: textColor,
            },
            grid: {
              display: false,
            },
            border: {
              color: mutedColor,
            },
          },
          y: {
            beginAtZero: Boolean(config.beginAtZero),
            title: {
              display: Boolean(config.yTitle),
              text: config.yTitle,
              color: textColor,
            },
            ticks: {
              color: textColor,
            },
            grid: {
              color: gridColor,
            },
            border: {
              color: mutedColor,
            },
          },
        },
      },
    })

    chartInstances.push(chart)
  }
}

document.addEventListener("nav", renderCharts)
document.addEventListener("themechange", renderCharts)
