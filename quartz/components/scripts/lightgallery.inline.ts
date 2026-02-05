let lgInstance: any = null

function cleanupStaleWrappers() {
  document.querySelectorAll("img.lg-wrapped").forEach((img) => {
    if (!img.closest(".lg-image")) {
      img.classList.remove("lg-wrapped")
    }
  })
}

function initGallery() {
  console.log("LightGallery: [Diagnostic] Starting initialization cycle...")

  const contentElement =
    document.querySelector("article") ||
    document.querySelector(".content") ||
    document.querySelector("main")

  if (!contentElement) {
    console.warn("LightGallery: [Skip] No content container found.")
    return
  }

  // @ts-ignore
  if (typeof lightGallery === "undefined") {
    console.error("LightGallery: [Error] library 'lightGallery' is not loaded.")
    return
  }

  if (lgInstance) {
    console.log("LightGallery: [Clean] Destroying previous instance.")
    try {
      lgInstance.destroy()
    } catch (e) {
      console.warn("LightGallery: [Clean] Error destroying instance:", e)
    }
    lgInstance = null
  }

  cleanupStaleWrappers()

  const images = contentElement.querySelectorAll("img")
  let wrapCount = 0

  images.forEach((img) => {
    if (img.closest(".lg-image") || img.closest("a")) return

    const wAttr = img.getAttribute("width")
    if (wAttr && parseInt(wAttr) < 50) return
    if (img.complete && img.naturalWidth > 0 && img.naturalWidth < 50) return

    const anchor = document.createElement("a")
    anchor.href = (img as HTMLImageElement).src
    anchor.className = "lg-image"
    anchor.setAttribute("data-src", (img as HTMLImageElement).src)
    img.classList.add("lg-wrapped")
    anchor.setAttribute("data-sub-html", " ")

    const width = img.getAttribute("width")
    if (width) {
      anchor.style.display = "inline-block"
      anchor.style.width = isNaN(Number(width)) ? width : width + "px"
    }

    if (img.parentNode) {
      img.parentNode.insertBefore(anchor, img)
      anchor.appendChild(img)
      wrapCount++
    }
  })

  const galleryItems = contentElement.querySelectorAll(".lg-image")
  console.log(`LightGallery: [Info] Found ${galleryItems.length} images to bind.`)

  if (galleryItems.length > 0) {
    try {
      const plugins = []
      // @ts-ignore
      if (window.lgThumbnail) plugins.push(window.lgThumbnail)
      // @ts-ignore
      if (window.lgZoom) plugins.push(window.lgZoom)
      // @ts-ignore
      if (window.lgFullscreen) plugins.push(window.lgFullscreen)

      console.log(`LightGallery: [Action] Initializing with ${plugins.length} plugins.`)

      // @ts-ignore
      lgInstance = lightGallery(contentElement, {
        plugins: plugins,
        selector: ".lg-image",
        speed: 500,
        licenseKey: "0000-0000-000-0000",
        getCaptionFromTitleOrAlt: false,
        mobileSettings: {
          controls: true,
          showCloseIcon: true,
          download: false,
        },
      })
      console.log("LightGallery: [Success] Initialization complete.")
    } catch (e) {
      console.error("LightGallery: [Error] Initialization failed:", e)
    }
  }
}

// @ts-ignore
let observer: MutationObserver | null = null
function setupObserver() {
  if (observer) return

  observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === "childList" && mutation.addedNodes.length > 0) {
        const article = document.querySelector("article")
        if (article && article.querySelector("img:not(.lg-wrapped)")) {
          console.log("LightGallery: [Observer] Detected new images, re-initializing.")
          initGallery()
          break
        }
      }
    }
  })

  observer.observe(document.body, { childList: true, subtree: true })
}

document.addEventListener("nav", () => {
  console.log("LightGallery: [Event] Quartz Nav.")
  initGallery()
  // Backup for micromorph delay
  setTimeout(initGallery, 50)
  setTimeout(initGallery, 500)
})

// Click rescue
document.addEventListener("click", (e) => {
  const target = e.target as HTMLElement
  const img = target.closest("article img")
  if (img && !img.closest(".lg-image") && !img.closest("a")) {
    console.log("LightGallery: [Rescue] Unwrapped image clicked. Refreshing...")
    initGallery()
  }
})

// Initial call
initGallery()
setupObserver()
