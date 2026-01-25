import { QuartzComponent, QuartzComponentConstructor, QuartzComponentProps } from "./types"
import { classNames } from "../util/lang"

const ArticleTitle: QuartzComponent = ({ fileData, displayClass }: QuartzComponentProps) => {
  const title = fileData.frontmatter?.title
  if (title) {
    return (
      <div class={classNames(displayClass, "article-title-container")}>
        <h1 class="article-title">{title}</h1>
        <a 
          href="https://creativecommons.org/licenses/by-nc-sa/4.0/deed.zh-hant" 
          target="_blank" 
          rel="noopener" 
          class="license-icon"
          title="本文內容採用 CC BY-NC-SA 4.0 授權"
        >
          <img 
            src="https://mirrors.creativecommons.org/presskit/buttons/88x31/svg/by-nc-sa.svg" 
            alt="CC BY-NC-SA 4.0" 
          />
        </a>
      </div>
    )
  } else {
    return null
  }
}

ArticleTitle.css = `
.article-title-container {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 1rem;
  margin: 2rem 0 0 0;
  flex-wrap: wrap;
}

.article-title {
  margin: 0;
  flex: 1;
  min-width: 300px;
}

.license-icon {
  height: 31px;
  flex-shrink: 0;
  opacity: 0.8;
  transition: opacity 0.2s ease;
  margin-bottom: 0.5rem; /* Align better with baseline */
}

.license-icon:hover {
  opacity: 1;
}

.license-icon img {
  height: 31px;
  width: auto;
  display: block;
}

@media all and (max-width: 600px) {
  .article-title-container {
    flex-direction: column;
    align-items: flex-start;
    gap: 0.5rem;
  }
  
  .license-icon {
    margin-bottom: 0;
  }
}
`

export default (() => ArticleTitle) satisfies QuartzComponentConstructor
