// @ts-ignore
import langToggleScript from "./scripts/langtoggle.inline"
import styles from "./styles/langtoggle.scss"
import { QuartzComponent, QuartzComponentConstructor, QuartzComponentProps } from "./types"
import { classNames } from "../util/lang"

const LanguageToggle: QuartzComponent = ({ displayClass }: QuartzComponentProps) => {
    return (
        <button
            class={classNames(displayClass, "lang-toggle")}
            aria-label="Toggle language (Chinese / English)"
            title="切換語言 / Toggle Language"
        >
            <span class="lang-label"></span>
        </button>
    )
}

LanguageToggle.beforeDOMLoaded = langToggleScript
LanguageToggle.css = styles

export default (() => LanguageToggle) satisfies QuartzComponentConstructor
