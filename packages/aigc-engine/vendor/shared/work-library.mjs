export function workCategory(work) {
  return ["detail_page", "main_image", "digital_human"].includes(work.category) ? work.category : "short_video";
}

export function filterWorks(works, { section = "library", category = "all", favoritesOnly = false } = {}) {
  return works.filter(work => Boolean(work.deletedAt) === (section === "trash") && (category === "all" || workCategory(work) === category) && (!favoritesOnly || work.favorite))
    .sort((a, b) => Number(Boolean(b.favorite)) - Number(Boolean(a.favorite)) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}
