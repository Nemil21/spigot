import { categoryLabel } from './labels';

const TONE: Record<string, string> = {
  AI_TRAINING: 'bg-accent-tint text-accent-strong',
  AI_AGENT: 'bg-info-tint text-info',
  SCRAPER_TOOL: 'bg-warning-tint text-warning',
  SEARCH: 'bg-positive-tint text-positive',
};

/** W04 category badge ("AI training", "Scraper"…). */
export function CategoryBadge({ category }: { category: string }) {
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${TONE[category] ?? 'bg-surface-2 text-body'}`}
      data-category={category}
    >
      {categoryLabel(category)}
    </span>
  );
}
