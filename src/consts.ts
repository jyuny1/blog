export const SITE_TITLE = "Kevin's Note"
export const SITE_DESCRIPTION =
  "Underwater photography, visual studies, and notes by Kevin Liu."
export const SITE_URL = "https://blog.ljy.app"
export const PORTFOLIO_URL = "https://portfolio.ljy.app"

export const isPublished = (data: { draft?: boolean; status?: string }) =>
  !data.draft && data.status?.toLowerCase() !== "draft"

export const byNewest = <T extends { data: { date?: Date } }>(a: T, b: T) =>
  (b.data.date?.getTime() ?? 0) - (a.data.date?.getTime() ?? 0)

export const formatDate = (date?: Date) =>
  date
    ? new Intl.DateTimeFormat("zh-TW", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(date)
    : "未註明日期"

export const readingTime = (body = "") => {
  const latinWords = body.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g)?.length ?? 0
  const cjkChars = body.match(/[\u3400-\u9fff\uf900-\ufaff]/g)?.length ?? 0
  return Math.max(1, Math.ceil(latinWords / 220 + cjkChars / 450))
}
