import { Bookmark, BookOpen, Box, Boxes, Building2, Calculator, CalendarDays, ChartColumn, Check, Circle, Database, Eye, File, FileBarChart, FileText, History, House, LayoutGrid, Layers, LifeBuoy, List, ListTree, Lock, Mail, Network, Notebook, Package, Settings, Shield, SlidersHorizontal, Sparkles, Split, Tags, Upload, Users, Workflow, type LucideIcon } from "lucide-react";

/** The icon names a manifest's `NavItem.icon` may use, by their lucide component; any other name shows a plain dot. */
const NAV_ICONS: Record<string, LucideIcon> = {
  "bar-chart": ChartColumn,
  bookmark: Bookmark,
  "book-open": BookOpen,
  boxes: Boxes,
  "calendar-days": CalendarDays,
  "file-bar-chart": FileBarChart,
  "file-text": FileText,
  home: House,
  layers: Layers,
  "list-tree": ListTree,
  network: Network,
  notebook: Notebook,
  sliders: SlidersHorizontal,
  split: Split,
  workflow: Workflow,
  box: Box,
  building: Building2,
  calculator: Calculator,
  check: Check,
  database: Database,
  eye: Eye,
  file: File,
  grid: LayoutGrid,
  history: History,
  "life-buoy": LifeBuoy,
  list: List,
  lock: Lock,
  mail: Mail,
  package: Package,
  settings: Settings,
  shield: Shield,
  sparkles: Sparkles,
  tags: Tags,
  upload: Upload,
  users: Users,
};

/** The icon of a menu item (decorative: the label names the item). */
export function NavIcon({ name }: { name: string }) {
  const Icon = NAV_ICONS[name] ?? Circle;
  return <Icon className="size-4 shrink-0" aria-hidden="true" />;
}
