// Language toggle script - sets cookie for middleware to read
const currentLang = localStorage.getItem("preferred-lang") || "auto"
document.documentElement.setAttribute("saved-lang", currentLang)

document.addEventListener("nav", () => {
    const switchLanguage = () => {
        const current = document.documentElement.getAttribute("saved-lang")
        // Cycle: auto -> zh -> en -> auto
        let newLang: string
        if (current === "auto") {
            newLang = "zh"
        } else if (current === "zh") {
            newLang = "en"
        } else {
            newLang = "auto"
        }

        document.documentElement.setAttribute("saved-lang", newLang)
        localStorage.setItem("preferred-lang", newLang)

        // Set cookie for middleware to read
        document.cookie = `preferred-lang=${newLang};path=/;max-age=31536000;SameSite=Lax`

        // Reload to apply translation
        window.location.reload()
    }

    for (const langButton of document.getElementsByClassName("lang-toggle")) {
        langButton.addEventListener("click", switchLanguage)
        window.addCleanup(() => langButton.removeEventListener("click", switchLanguage))
    }
})
