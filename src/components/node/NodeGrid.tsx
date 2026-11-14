import { t } from "@/i18n";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { CircleDollarSign } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { useDragReorder } from "@/hooks/useDragReorder";
import {
  useAllNodeMeta,
  useHomeNodeSummaries,
  useNodeStoreStatus,
} from "@/hooks/useNode";
import { useHomepagePingOverview } from "@/hooks/usePingOverview";
import { usePublicConfig } from "@/hooks/usePublicConfig";
import { useThemeSettings } from "@/hooks/useThemeSettings";
import { useViewMode } from "@/hooks/useViewMode";
import {
  formatBytes,
  formatByteRate,
  formatByteRateLabel,
} from "@/utils/format";
import { calculateCostSummary, getExchangeRates } from "@/utils/cost";
import { useHiddenNodeUuids } from "@/hooks/useVisibleNodes";
import { collectMatchingNodeUuids } from "@/utils/nodeIdentity";
import { computeTrafficUsed, resolveTrafficUsage } from "@/utils/traffic";
import { speedRateColor } from "@/utils/metricTone";
import {
  getHomeGroupLabel,
  getHomeGroupOptions,
  getHomeRegionOptions,
  HOME_ALL_GROUP,
  HOME_ALL_REGION,
  mergeHomeRegionOrder,
  sortHomeGroupOptions,
} from "@/utils/homeNodes";
import { getDisplayRegionCode } from "@/utils/geo";
import { useHomeSort } from "@/hooks/useHomeSort";
import { useHomeNodeOrder } from "@/hooks/useHomeNodeOrder";
import { useHourlyClock } from "@/hooks/useClock";
import { usePacedRate } from "@/hooks/usePacedRate";
import { preloadAssetsPage } from "@/services/assetsPageLoader";
import { refreshServersSnapshot } from "@/services/wsStore";
import { getLocalThemeSettings, saveLocalThemeSettings } from "@/services/themeSettingsStore";
import { HomeSortControl } from "./HomeSortControl";
import {
  getOverviewRating,
  type OverviewRating,
} from "@/utils/overviewRating";
import { CompactNodeCard } from "./CompactNodeCard";
import { MiniNodeCard } from "./MiniNodeCard";
import { NodeCard } from "./NodeCard";
import { NodeListView } from "./NodeListView";
import { RegionTabs } from "./RegionTabs";
import type { NodeViewMode } from "@/utils/themeSettings";

// 卡片视图网格密度；列表档由独立组件布局。
const GRID_LAYOUT: Record<NodeViewMode, { className: string; minColumnWidth: number }> = {
  large: { className: "grid gap-4 xl:gap-5", minColumnWidth: 360 },
  compact: { className: "grid gap-3 xl:gap-4", minColumnWidth: 340 },
  mini: { className: "grid gap-3 xl:gap-3.5", minColumnWidth: 260 },
  // 占位以满足 Record 穷尽。
  list: { className: "", minColumnWidth: 0 },
};

type MiniGridStyle = CSSProperties & { "--mini-card-min-width": string };

// 标准 UUID 不含逗号，可安全拼成稳定签名。
const UUID_KEY_SEPARATOR = ",";
/** 汇率接口失败时的占位，保持引用稳定，让 useMemo 不会每次渲染都重算。 */
const EMPTY_RATES: Record<string, number> = {};
const EMPTY_REGION_ORDER: string[] = [];
/** 周期/明细数据不在 WS 里，低频补拉一次完整快照。 */
const SERVER_SNAPSHOT_REFRESH_MS = 5 * 60 * 1000;

type IdleCapableWindow = Window & {
  requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
};

interface HomeOverview {
  totalNodes: number;
  onlineNodes: number;
  offlineNodes: number;
  /** 勾选节点按各自 traffic_limit_type 计算出的合计（不是原始 ↑+↓）。 */
  trafficTotal: number;
  /** 勾选节点的原始累计上行/下行，仅用于卡片副行展示。 */
  trafficUp: number;
  trafficDown: number;
  netUp: number;
  netDown: number;
  /** 第二张实时带宽卡的合计。 */
  netUp2: number;
  netDown2: number;
}

interface TrafficDetailRow {
  uuid: string;
  name: string;
  /** 卡片里用的短名：取最后一个下划线后的部分，避免 3 列放不下。 */
  shortName: string;
  used: number;
  remaining: number;
  unlimited: boolean;
  /** 配额使用百分比；不限流量为 null。 */
  percent: number | null;
  /** null = 不重置；其余为距离下次重置的自然日数。 */
  resetDays: number | null;
}

function formatCompactBytes(value: number): string {
  const [amount, unit = "B"] = formatBytes(value).split(" ");
  return `${amount}${unit[0]}`;
}

/** 与 Agent 的 actualResetDate 对齐：当月没有该日时顺延到次月 1 日。 */
function nextResetDate(resetDay: number, now: Date): Date {
  const build = (year: number, month: number): Date => {
    const lastDay = new Date(year, month + 1, 0).getDate();
    if (resetDay <= lastDay) return new Date(year, month, resetDay, 0, 0, 0, 0);
    return new Date(year, month + 1, 1, 0, 0, 0, 0);
  };
  let next = build(now.getFullYear(), now.getMonth());
  if (next.getTime() <= now.getTime()) {
    next = build(now.getFullYear(), now.getMonth() + 1);
  }
  return next;
}

/** 浏览器本地时区下的自然日数；Agent 按服务器本地时区重置，跨时区时可能差一天。 */
function daysUntilReset(resetDay: number, nowMs: number): number | null {
  if (!Number.isFinite(resetDay) || resetDay < 1 || resetDay > 31) return null;
  const now = new Date(nowMs);
  const next = nextResetDate(resetDay, now);
  return Math.max(0, Math.ceil((next.getTime() - now.getTime()) / 86_400_000));
}

function formatResetLabel(resetDays: number | null): string {
  if (resetDays == null) return t("home.trafficDetailNoReset");
  if (resetDays <= 0) return t("home.trafficDetailResetToday");
  return t("home.trafficDetailReset", { days: resetDays });
}

/** 0–25 / 26–50 / 51–75 / 76–100 四段，对应实时带宽的四档颜色。 */
function percentColor(percent: number | null): string {
  if (percent == null) return "var(--text-secondary)";
  if (percent <= 25) return "var(--speed-idle)";
  if (percent <= 50) return "var(--speed-low)";
  if (percent <= 75) return "var(--speed-high)";
  return "var(--speed-max)";
}

// 站点铭牌由 CSS 放进 AppShell 顶部留白，不占概览卡内容流。
function HomeBrand({ siteName }: { siteName: string }) {
  return (
    <header className="home-brand" aria-label={t("home.siteNameLabel")}>
      <h1 className="home-brand-title" title={siteName}>
        {siteName}
      </h1>
    </header>
  );
}

function HomeOverviewCards({
  overview,
  detailRows,
  showDetailCard,
  showOverviewRatings,
  showBandwidthRating,
  bandwidthRatingLabels,
  dense,
}: {
  overview: HomeOverview;
  detailRows: TrafficDetailRow[];
  showDetailCard: boolean;
  dense: boolean;
  showOverviewRatings: boolean;
  showBandwidthRating: boolean;
  bandwidthRatingLabels: string;
}) {
  const [detailTotalValue, detailTotalUnit] = formatBytes(overview.trafficTotal).split(" ");
  const rate = formatByteRate(overview.netUp + overview.netDown);
  const rate2 = formatByteRate(overview.netUp2 + overview.netDown2);
  const trafficDetailLabel = `↑ ${formatBytes(overview.trafficUp)} · ↓ ${formatBytes(overview.trafficDown)}`;
  const bandwidthDetailLabel = `↑ ${formatByteRateLabel(overview.netUp)} · ↓ ${formatByteRateLabel(overview.netDown)}`;
  const bandwidthCompactLabel = `↑${formatCompactBytes(overview.netUp)} ↓${formatCompactBytes(overview.netDown)}`;
  const bandwidth2DetailLabel = `↑ ${formatByteRateLabel(overview.netUp2)} · ↓ ${formatByteRateLabel(overview.netDown2)}`;
  const bandwidth2CompactLabel = `↑${formatCompactBytes(overview.netUp2)} ↓${formatCompactBytes(overview.netDown2)}`;
  const bandwidthRating =
    showOverviewRatings && showBandwidthRating
      ? getOverviewRating({
          kind: "bandwidth",
          value: overview.netUp + overview.netDown,
          customLabels: bandwidthRatingLabels,
        })
      : null;
  const bandwidth2Rating =
    showOverviewRatings && showBandwidthRating
      ? getOverviewRating({
          kind: "bandwidth",
          value: overview.netUp2 + overview.netDown2,
          customLabels: bandwidthRatingLabels,
        })
      : null;
  const renderRating = (rating: OverviewRating | null) =>
    rating ? (
      <span className="overview-card-rating" data-rating-level={rating.level} title={rating.label}>
        {rating.label}
      </span>
    ) : null;

  return (
    // 资产卡可以单独关掉，列数跟着实际张数走，不然右边空一格。
    <section
      className={`home-overview${dense ? " is-dense" : ""}`}
      data-cards={showDetailCard ? 3 : 2}
      aria-label={t("home.overviewLabel")}
    >
      <article className="overview-card" data-metric="bandwidth">
        <span className="overview-card-label">{t("home.liveBandwidth1")}</span>
        <div className="overview-card-main">
          <p
            className="overview-card-value"
            style={{ color: speedRateColor(rate.unit) }}
          >
            {rate.value}
            <span className="overview-card-unit">{rate.unit}</span>
          </p>
        </div>
        <div className="overview-card-footer">
          <p className="overview-card-sub" title={bandwidthDetailLabel}>
            <span className="overview-card-sub-full">{bandwidthDetailLabel}</span>
            <span className="overview-card-sub-compact">{bandwidthCompactLabel}</span>
          </p>
          {renderRating(bandwidthRating)}
        </div>
      </article>

      <article className="overview-card" data-metric="bandwidth-2">
        <span className="overview-card-label">{t("home.liveBandwidth2")}</span>
        <div className="overview-card-main">
          <p
            className="overview-card-value"
            style={{ color: speedRateColor(rate2.unit) }}
          >
            {rate2.value}
            <span className="overview-card-unit">{rate2.unit}</span>
          </p>
        </div>
        <div className="overview-card-footer">
          <p className="overview-card-sub" title={bandwidth2DetailLabel}>
            <span className="overview-card-sub-full">{bandwidth2DetailLabel}</span>
            <span className="overview-card-sub-compact">{bandwidth2CompactLabel}</span>
          </p>
          {renderRating(bandwidth2Rating)}
        </div>
      </article>

      {showDetailCard && (
        <article className="overview-card" data-metric="traffic-detail">
          <div className="overview-card-head">
            <span className="overview-card-label">{t("home.trafficDetail")}</span>
            <span className="overview-card-sub traffic-detail-head-sub" title={trafficDetailLabel}>
              {trafficDetailLabel}
            </span>
          </div>
          {detailRows.length === 0 ? (
            <div className="traffic-detail-list">
              <span className="traffic-detail-empty">{t("home.trafficDetailEmpty")}</span>
            </div>
          ) : (
            <div
              className="traffic-detail-percent-grid"
              style={{
                gridTemplateColumns: `minmax(132px, auto) repeat(${detailRows.length}, minmax(0, 1fr))`,
              }}
            >
              <span className="overview-card-value traffic-detail-total-block">
                <span className="traffic-detail-percent-number">
                  {detailTotalValue}
                  <span className="overview-card-unit traffic-detail-percent-unit">
                    {detailTotalUnit}
                  </span>
                </span>
                <span className="overview-card-sub traffic-detail-percent-caption">
                  {t("home.trafficDetailUsedLabel")}
                </span>
              </span>
              {detailRows.map((row) => (
                <span
                  key={`${row.uuid}-percent`}
                  className="overview-card-value traffic-detail-percent-value"
                  style={{ color: percentColor(row.percent) }}
                  title={`${row.name} · ${t("home.trafficDetailUsed", { value: formatBytes(row.used) })} · ${
                    row.unlimited
                      ? t("home.trafficDetailUnlimited")
                      : t("home.trafficDetailRemaining", { value: formatBytes(row.remaining) })
                  } · ${formatResetLabel(row.resetDays)}`}
                >
                  {row.percent == null ? "∞" : `${row.percent}%`}
                </span>
              ))}
              {detailRows.map((row) => (
                <span
                  key={`${row.uuid}-name`}
                  className="overview-card-sub traffic-detail-percent-name"
                  title={row.name}
                >
                  {row.shortName}
                </span>
              ))}
            </div>
          )}
        </article>
      )}
    </section>
  );
}

/**
 * 分组栏伸展开时的样式：占满整行、宽度按内容，右边给排序按钮（同一行、钉在最后一列右侧）留出它自己的宽度和一道间距。
 * 不按「伸到倒数第二列」算：排序按钮只有几十像素宽，却占着一整列，两列时右边会空出一大块。
 */
function groupTabsSpanStyle(reservePx: number): CSSProperties {
  return {
    gridColumn: "1 / -1",
    gridRow: "1",
    justifySelf: "start",
    width: "max-content",
    maxWidth: reservePx > 0 ? `calc(100% - ${Math.ceil(reservePx)}px)` : "100%",
  };
}

function GroupTabs({
  groups,
  selectedGroup,
  onSelectGroup,
  onReorder,
  hasSort,
}: {
  groups: string[];
  selectedGroup: string;
  onSelectGroup: (group: string) => void;
  onReorder: (groups: string[]) => void;
  hasSort: boolean;
}) {
  // 和地区栏一样可以直接拖动排序（「全部」固定在最前，不参与）。
  const { containerRef, order, draggingCode, itemRef, itemHandlers, shouldIgnoreClick } =
    useDragReorder({ codes: groups, onReorder, axis: "x" });
  const [spanStyle, setSpanStyle] = useState<CSSProperties | undefined>(undefined);

  // 分组栏平时占一张卡的宽度、和第一张卡左右对齐；分组多到这一格放不下时，往右伸到排序按钮前为止
  // （issue #10：原来只能在一格里横向滚动，右边空着）。伸到头还放不下就照旧横向滚动，不换行（站长定）。
  // 手机上控件栏不是网格（≤ 768px 是 flex），保持横向滑动。
  useLayoutEffect(() => {
    const bar = containerRef.current;
    const grid = bar?.parentElement;
    if (!bar || !grid) return;
    const measure = () => {
      const gridStyle = getComputedStyle(grid);
      const columns =
        gridStyle.display === "grid"
          ? gridStyle.gridTemplateColumns.split(" ").map(Number.parseFloat).filter(Number.isFinite)
          : [];
      if (columns.length < 2) {
        delete grid.dataset.groupsSpan;
        setSpanStyle(undefined);
        return;
      }
      // 不受当前是否伸展影响地量出「把分组全部摆开要多宽」：临时按内容定宽量一下再还原（同一帧内，不会闪）。
      // 伸展时行内带着 max-width: 100%，量的时候也要去掉，不然量到的是被它截过的宽度、来回判断（实测会在两态间跳）。
      const { width: previousWidth, maxWidth: previousMaxWidth } = bar.style;
      bar.style.width = "max-content";
      bar.style.maxWidth = "none";
      const needed = bar.getBoundingClientRect().width;
      bar.style.width = previousWidth;
      bar.style.maxWidth = previousMaxWidth;
      const fits = needed <= columns[0]! + 0.5;
      // 伸展时排序按钮要和分组栏同一行（见 home.css 的 data-groups-span），它原本靠自动排位落在第一行。
      if (fits) delete grid.dataset.groupsSpan;
      else grid.dataset.groupsSpan = "true";
      const sort = hasSort ? grid.querySelector<HTMLElement>(".home-sort") : null;
      const reserve = sort
        ? sort.getBoundingClientRect().width + (Number.parseFloat(gridStyle.columnGap) || 0)
        : 0;
      setSpanStyle((current) => {
        if (fits) return undefined;
        const next = groupTabsSpanStyle(reserve);
        return current?.maxWidth === next.maxWidth ? current : next;
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(grid);
    return () => {
      observer.disconnect();
      delete grid.dataset.groupsSpan;
    };
  }, [containerRef, groups, hasSort]);

  return (
    <div
      ref={containerRef}
      className="home-group-tabs"
      role="group"
      aria-label={t("home.groupsLabel")}
      style={spanStyle}
      data-reordering={draggingCode ? "true" : undefined}
    >
      <button
        type="button"
        aria-pressed={selectedGroup === HOME_ALL_GROUP}
        data-active={selectedGroup === HOME_ALL_GROUP ? "true" : "false"}
        onClick={() => onSelectGroup(HOME_ALL_GROUP)}
      >
        {t("common.all")}
      </button>
      {order.map((group) => (
        <button
          key={group}
          ref={itemRef(group)}
          type="button"
          className="home-group-tab-draggable"
          aria-pressed={selectedGroup === group}
          data-active={selectedGroup === group ? "true" : "false"}
          data-dragging={draggingCode === group ? "true" : undefined}
          {...itemHandlers(group)}
          onClick={() => {
            if (shouldIgnoreClick()) return;
            onSelectGroup(group);
          }}
          title={group}
        >
          {group}
        </button>
      ))}
    </div>
  );
}

export function NodeGrid() {
  const now = useHourlyClock();
  const nodes = useHomeNodeSummaries();
  const allMeta = useAllNodeMeta();
  const { hydrated: storeHydrated, nodeInfoError } = useNodeStoreStatus();
  const { data: me } = useAuth();
  const { data: publicConfig } = usePublicConfig();
  const siteName = publicConfig?.sitename?.trim() || t("home.defaultSiteName");
  const themeSettings = useThemeSettings();
  const { mode } = useViewMode();
  const sort = useHomeSort();
  // enableHomeSort 控制访客能否改排序;关闭时无视 session 覆盖、直接用管理员默认序(默认仍是 weight)。
  const sortEnabled = themeSettings.isReady && themeSettings.enableHomeSort;
  const sortField = sortEnabled ? sort.field : themeSettings.homeSortField;
  const sortDirection = sortEnabled ? sort.direction : themeSettings.homeSortDirection;
  const [selectedGroup, setSelectedGroup] = useState(HOME_ALL_GROUP);
  const [selectedRegion, setSelectedRegion] = useState(HOME_ALL_REGION);
  useHomepagePingOverview(mode);

  // 摘要不含名称，先从完整 meta 解析主题隐藏列表，再统一过滤各类数据。
  const hiddenUuids = useHiddenNodeUuids();
  const visibleNodes = useMemo(
    () =>
      nodes.filter(
        (node) => (me?.logged_in === true || !node.hidden) && !hiddenUuids.has(node.uuid),
      ),
    [me?.logged_in, nodes, hiddenUuids],
  );
  // 资产统计与卡片使用同一可见性规则，避免泄露隐藏节点信息。
  const visibleMeta = useMemo(
    () =>
      allMeta.filter(
        (node) => (me?.logged_in === true || !node.hidden) && !hiddenUuids.has(node.uuid),
      ),
    [allMeta, me?.logged_in, hiddenUuids],
  );
  const metaByUuid = useMemo(
    () => new Map(visibleMeta.map((node) => [node.uuid, node])),
    [visibleMeta],
  );
  // 「名称」排序需要展示名(摘要无 name),从 meta 注入。
  const nameByUuid = useMemo(() => {
    const map = new Map<string, string>();
    for (const node of visibleMeta) map.set(node.uuid, node.name?.trim() || node.uuid);
    return map;
  }, [visibleMeta]);
  // null = 全部可见节点；[] = 全不统计；非空 = 只统计匹配的节点。
  const trafficIncludedUuids = useMemo(
    () =>
      themeSettings.trafficIncludedNodes === null
        ? null
        : collectMatchingNodeUuids(visibleMeta, themeSettings.trafficIncludedNodes),
    [themeSettings.trafficIncludedNodes, visibleMeta],
  );
  const speedIncludedUuids = useMemo(
    () =>
      themeSettings.speedIncludedNodes === null
        ? null
        : collectMatchingNodeUuids(visibleMeta, themeSettings.speedIncludedNodes),
    [themeSettings.speedIncludedNodes, visibleMeta],
  );
  const speed2IncludedUuids = useMemo(
    () =>
      themeSettings.speed2IncludedNodes === null
        ? null
        : collectMatchingNodeUuids(visibleMeta, themeSettings.speed2IncludedNodes),
    [themeSettings.speed2IncludedNodes, visibleMeta],
  );
  const detailIncludedUuids = useMemo(
    () => collectMatchingNodeUuids(visibleMeta, themeSettings.detailIncludedNodes ?? []),
    [themeSettings.detailIncludedNodes, visibleMeta],
  );
  const overview = useMemo<HomeOverview>(() => {
    let onlineNodes = 0;
    let offlineNodes = 0;
    let trafficTotal = 0;
    let trafficUp = 0;
    let trafficDown = 0;
    let netUp = 0;
    let netDown = 0;
    let netUp2 = 0;
    let netDown2 = 0;
    const period = themeSettings.trafficTimeMode === "period";
    for (const node of visibleNodes) {
      if (node.online === true) onlineNodes += 1;
      else if (node.online === false) offlineNodes += 1;

      if (trafficIncludedUuids === null || trafficIncludedUuids.has(node.uuid)) {
        const meta = metaByUuid.get(node.uuid);
        const up = period ? node.trafficUpMonthly ?? 0 : node.trafficUp;
        const down = period ? node.trafficDownMonthly ?? 0 : node.trafficDown;
        trafficUp += up;
        trafficDown += down;
        // 按每台探针后台的「月流量计算类型」取数；缺 meta 时退回上下行合计。
        trafficTotal += meta ? computeTrafficUsed(meta.traffic_limit_type, up, down) : up + down;
      }

      if (speedIncludedUuids === null || speedIncludedUuids.has(node.uuid)) {
        netUp += node.netUp;
        netDown += node.netDown;
      }
      if (speed2IncludedUuids === null || speed2IncludedUuids.has(node.uuid)) {
        netUp2 += node.netUp;
        netDown2 += node.netDown;
      }
    }

    return {
      totalNodes: visibleNodes.length,
      onlineNodes,
      offlineNodes,
      trafficTotal,
      trafficUp,
      trafficDown,
      netUp,
      netDown,
      netUp2,
      netDown2,
    };
  }, [
    metaByUuid,
    speed2IncludedUuids,
    speedIncludedUuids,
    themeSettings.trafficTimeMode,
    trafficIncludedUuids,
    visibleNodes,
  ]);

  // 明细卡固定用「当前周期 + 每台配额口径」：剩余/重置只有周期口径才有意义。
  const detailRows = useMemo<TrafficDetailRow[]>(() => {
    if (detailIncludedUuids.size === 0) return [];
    const summaries = new Map(visibleNodes.map((node) => [node.uuid, node]));
    const rows: TrafficDetailRow[] = [];
    for (const meta of visibleMeta) {
      if (!detailIncludedUuids.has(meta.uuid)) continue;
      const summary = summaries.get(meta.uuid);
      const usage = resolveTrafficUsage(
        meta.traffic_limit_type,
        summary?.trafficUpMonthly ?? 0,
        summary?.trafficDownMonthly ?? 0,
        meta.traffic_limit,
      );
      const name = meta.name?.trim() || meta.uuid;
      rows.push({
        uuid: meta.uuid,
        name,
        shortName: name.includes("_") ? name.split("_").pop() || name : name,
        used: usage.used,
        remaining: usage.remaining,
        unlimited: usage.unlimited,
        percent: usage.unlimited ? null : Math.round(usage.fraction * 100),
        resetDays: daysUntilReset(meta.traffic_reset_day, now),
      });
      if (rows.length >= 3) break;
    }
    return rows;
  }, [detailIncludedUuids, now, visibleMeta, visibleNodes]);
  // 顶部「实时带宽」是跨节点求和，各节点相位不同会让它一秒内变好几次。
  // 单独按 1 秒节拍统一换一次；卡片仍按各自节奏刷新。
  const pacedNet = usePacedRate(overview.netUp, overview.netDown);
  const pacedNet2 = usePacedRate(overview.netUp2, overview.netDown2);
  const displayOverview = useMemo<HomeOverview>(
    () => ({
      ...overview,
      netUp: pacedNet.up,
      netDown: pacedNet.down,
      netUp2: pacedNet2.up,
      netDown2: pacedNet2.down,
    }),
    [overview, pacedNet, pacedNet2],
  );
  const showHomeOverview = themeSettings.isReady && themeSettings.showHomeOverview;
  const hasNodes = visibleMeta.length > 0;

  // 周期流量/明细来自 /api/servers 快照，WS 只推实时字段；每 5 分钟补拉一次。
  useEffect(() => {
    if (!themeSettings.isReady) return;
    const tick = () => {
      if (!document.hidden) refreshServersSnapshot();
    };
    const timer = window.setInterval(tick, SERVER_SNAPSHOT_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [themeSettings.isReady]);
  // 「流量明细」卡复用原资产卡的开关；单独一个开关，不跟着整排总览走。
  const showDetailCard = showHomeOverview && hasNodes && themeSettings.showAssetOverview;
  // 资产页保留悬浮入口；明细卡不再承载资产金额，避免入口丢失。
  const showCostEntry = themeSettings.isReady && themeSettings.showCostSummary && hasNodes;
  const showCostFloatingButton = showCostEntry;

  useEffect(() => {
    if (!showCostFloatingButton) return;

    const idleWindow = window as IdleCapableWindow;
    if (idleWindow.requestIdleCallback) {
      const handle = idleWindow.requestIdleCallback(preloadAssetsPage, { timeout: 2_000 });
      return () => idleWindow.cancelIdleCallback?.(handle);
    }

    // Safari 等无 requestIdleCallback 的浏览器，在首页稳定后再低优先级预取。
    const handle = window.setTimeout(preloadAssetsPage, 1_000);
    return () => window.clearTimeout(handle);
  }, [showCostFloatingButton]);

  // 资产入口存在时预热汇率，供价格排序和资产页复用。
  const costNeeded = showCostFloatingButton;
  const rateQuery = useQuery({
    queryKey: ["cost-rates", themeSettings.costRateApiUrl],
    queryFn: ({ signal }) => getExchangeRates(themeSettings.costRateApiUrl, { signal }),
    staleTime: 60 * 60 * 1000,
    // 「价格」排序也要汇率换算月化价,即便没显示资产卡也得拉一次;但空列表无需拉。
    enabled: (costNeeded || sortField === "price") && hasNodes,
    retry: 1,
  });
  // 汇率接口拿不到时不能整卡显示 "—"：人民币定价的节点根本不需要换算，照样统计，
  // 只有外币节点会被标成「汇率缺失」不计入。
  // 注意不能只判断 isError：请求失败、被 CSP 拦下、或 React Query 判定离线把请求
  // 挂起（fetchStatus: "paused"）时查询都停在 pending，永远等不到 error。
  // 只要不是正在请求且没有数据，就按「没有汇率」出结果。
  const ratesFetching = rateQuery.fetchStatus === "fetching" && !rateQuery.data;
  const costRates = rateQuery.data?.rates ?? (ratesFetching ? null : EMPTY_RATES);
  const costSummary = useMemo(
    () =>
      costRates
        ? calculateCostSummary(
            visibleMeta,
            themeSettings.costIgnoredNodes,
            costRates,
            themeSettings.costPremiums,
            now,
          )
        : null,
    [now, visibleMeta, themeSettings.costIgnoredNodes, themeSettings.costPremiums, costRates],
  );
  // 「价格」排序键:月化价格(CNY);免费/忽略/汇率缺失的节点 null,排到默认序之后。
  const priceByUuid = useMemo(() => {
    const map = new Map<string, number | null>();
    if (costSummary) {
      for (const detail of costSummary.details) {
        map.set(detail.uuid, detail.counted ? detail.monthlyCny : null);
      }
    }
    return map;
  }, [costSummary]);
  const groupOptions = useMemo(
    () =>
      sortHomeGroupOptions(
        getHomeGroupOptions(visibleNodes),
        themeSettings.isReady ? themeSettings.homeGroupOrder : [],
      ),
    [visibleNodes, themeSettings.homeGroupOrder, themeSettings.isReady],
  );
  // 分组栏上拖完的顺序直接写本机设置，和地区栏同一条路（访客只影响自己，登录站长自动同步到后端）。
  // 存过、但现在没有节点的分组也留着原位置（mergeHomeRegionOrder 只是按「显示的那几个」回填，分组同样适用）。
  const handleGroupReorder = useCallback(
    (visibleAfter: string[]) => {
      const previous = themeSettings.isReady ? themeSettings.homeGroupOrder : [];
      saveLocalThemeSettings({
        ...getLocalThemeSettings(),
        homeGroupOrder: mergeHomeRegionOrder(previous, groupOptions, visibleAfter),
      });
    },
    [groupOptions, themeSettings.homeGroupOrder, themeSettings.isReady],
  );
  // 站长设的默认分组只在首屏套一次：后面访客自己点了哪组就是哪组，配置回流不该把人拽回去。
  // 后端没有这个分组（改名 / 删了）时留在「全部」。
  const defaultGroupApplied = useRef(false);
  useEffect(() => {
    if (defaultGroupApplied.current) return;
    if (!themeSettings.isReady || groupOptions.length === 0) return;
    defaultGroupApplied.current = true;
    const preset = themeSettings.homeDefaultGroup;
    if (preset && groupOptions.includes(preset)) setSelectedGroup(preset);
  }, [groupOptions, themeSettings.homeDefaultGroup, themeSettings.isReady]);

  const groupFilteredNodes = useMemo(
    () =>
      selectedGroup === HOME_ALL_GROUP
        ? visibleNodes
        : visibleNodes.filter((node) => getHomeGroupLabel(node.group) === selectedGroup),
    [visibleNodes, selectedGroup],
  );
  // 地区选项在分组筛选之后统计,让国旗计数反映当前分组内的分布。
  const homeRegionOrder = themeSettings.isReady ? themeSettings.homeRegionOrder : EMPTY_REGION_ORDER;
  const regionOptions = useMemo(
    () => getHomeRegionOptions(groupFilteredNodes, homeRegionOrder),
    [groupFilteredNodes, homeRegionOrder],
  );
  // 地区栏上拖完的顺序直接写本机设置：访客只影响自己；登录站长跟别的设置一样自动同步到后端。
  // 当前分组只显示一部分地区，要并回完整顺序，别的分组里排好的不能丢（见 mergeHomeRegionOrder）。
  const handleRegionReorder = useCallback(
    (visibleAfter: string[]) => {
      saveLocalThemeSettings({
        ...getLocalThemeSettings(),
        homeRegionOrder: mergeHomeRegionOrder(
          homeRegionOrder,
          regionOptions.map((option) => option.code),
          visibleAfter,
        ),
      });
    },
    [homeRegionOrder, regionOptions],
  );
  const filteredNodes = useMemo(
    () =>
      selectedRegion === HOME_ALL_REGION
        ? groupFilteredNodes
        : groupFilteredNodes.filter((node) => getDisplayRegionCode(node.region) === selectedRegion),
    [groupFilteredNodes, selectedRegion],
  );
  // 排序在分组筛选之后。离线永远沉底(写死,见 homeSort);实时网速走防抖(键平滑+滞回+5s 重排)。
  const orderedNodes = useHomeNodeOrder({
    offlineFirst: themeSettings.isReady && themeSettings.offlineNodesFirst,
    nodes: filteredNodes,
    field: sortField,
    direction: sortDirection,
    nameByUuid,
    priceByUuid,
  });

  useEffect(() => {
    if (selectedGroup !== HOME_ALL_GROUP && !groupOptions.includes(selectedGroup)) {
      setSelectedGroup(HOME_ALL_GROUP);
    }
  }, [groupOptions, selectedGroup]);

  // 选中的地区在当前分组里不存在了(切换分组/节点变化)就回到全部。
  useEffect(() => {
    if (
      selectedRegion !== HOME_ALL_REGION &&
      !regionOptions.some((option) => option.code === selectedRegion)
    ) {
      setSelectedRegion(HOME_ALL_REGION);
    }
  }, [regionOptions, selectedRegion]);

  // 地区栏被配置关闭(热更新)时,清掉可能残留的地区筛选,否则会留下一个不可见的过滤条件。
  useEffect(() => {
    if (!themeSettings.showRegionBar && selectedRegion !== HOME_ALL_REGION) {
      setSelectedRegion(HOME_ALL_REGION);
    }
  }, [themeSettings.showRegionBar, selectedRegion]);

  useEffect(() => {
    if (!themeSettings.showGroupTabs && selectedGroup !== HOME_ALL_GROUP) {
      setSelectedGroup(HOME_ALL_GROUP);
    }
  }, [themeSettings.showGroupTabs, selectedGroup]);

  // 卡片列表只随 UUID 集合/顺序变化；卡片内部各自订阅实时数据。
  const uuidsKey = useMemo(
    () => orderedNodes.map((node) => node.uuid).join(UUID_KEY_SEPARATOR),
    [orderedNodes],
  );
  const orderedUuids = useMemo(
    () => (uuidsKey ? uuidsKey.split(UUID_KEY_SEPARATOR) : []),
    [uuidsKey],
  );
  // 列表档由下方 NodeListView 渲染,这里不必构造卡片元素。
  const cards = useMemo(
    () =>
      mode === "list"
        ? null
        : orderedUuids.map((uuid) => (
            <div key={uuid} className="min-w-0">
              {mode === "mini" ? (
                <MiniNodeCard
                  uuid={uuid}
                />
              ) : mode === "compact" ? (
                <CompactNodeCard
                  uuid={uuid}
                />
              ) : (
                <NodeCard
                  uuid={uuid}
                />
              )}
            </div>
          )),
    [orderedUuids, mode],
  );
  const showGroupTabs =
    themeSettings.isReady && themeSettings.showGroupTabs && groupOptions.length > 0;
  const showHomeSort = sortEnabled && visibleNodes.length > 1;
  // 地区栏:只有一个地区时筛选无意义,>1 才显示。
  const showRegionBar =
    themeSettings.isReady && themeSettings.showRegionBar && regionOptions.length > 1;
  // 分组标签栏与卡片网格共用列定义，让标签栏左缘对齐首卡。
  const isMini = mode === "mini";
  const isList = mode === "list";
  const { className: gridClassName, minColumnWidth } = GRID_LAYOUT[mode];
  const gridWrapClassName = isMini ? `${gridClassName} node-grid-mini` : gridClassName;
  const gridStyle = isList
    ? undefined
    : isMini
      ? ({ "--mini-card-min-width": `${minColumnWidth}px` } as MiniGridStyle)
      : { gridTemplateColumns: `repeat(auto-fill, minmax(min(100%, ${minColumnWidth}px), 1fr))` };
  const gridElement = (
    <div className={gridWrapClassName} style={gridStyle}>
      {cards}
    </div>
  );
  // 迷你与列表档的控件栏借用小卡列宽，避免跟随密集内容列而被压窄。
  const borrowControlsGrid = isMini || isList;
  const controlsWrapClassName = borrowControlsGrid
    ? "grid gap-3 home-controls-bar mb-4"
    : `${gridWrapClassName} home-controls-bar mb-4`;
  const controlsStyle = borrowControlsGrid
    ? {
        gridTemplateColumns: `repeat(auto-fill, minmax(min(100%, ${GRID_LAYOUT.compact.minColumnWidth}px), 1fr))`,
      }
    : gridStyle;

  if (!themeSettings.isReady || !storeHydrated) {
    if (!nodeInfoError) return null;
    return (
      <div
        className="flex h-[40vh] flex-col items-center justify-center gap-2 text-[var(--text-tertiary)]"
        aria-live="polite"
      >
        <span className="text-[14px]">{t("home.loadFailed")}</span>
        <span className="text-[12px]">{t("home.loadRetrying")}</span>
      </div>
    );
  }

  // 资产页悬浮入口 + 首页概览卡在「空节点」与正常两个分支里完全一致，提取一次复用。
  const homeHeader = (
    <>
      {showCostFloatingButton && (
        <Link
          to="/assets"
          className="cost-summary-ball show"
          aria-label={t("home.openAssets")}
          title={t("home.assetsTitle")}
        >
          <span className="cost-summary-ball-icon" aria-hidden>
            <CircleDollarSign size={16} />
          </span>
        </Link>
      )}
      <HomeBrand siteName={siteName} />
      {showHomeOverview && (
        <HomeOverviewCards
          overview={displayOverview}
          detailRows={detailRows}
          showDetailCard={showDetailCard}
          dense={mode === "mini" || mode === "list"}
          showOverviewRatings={themeSettings.showOverviewRatings}
          showBandwidthRating={themeSettings.showBandwidthRating}
          bandwidthRatingLabels={themeSettings.bandwidthRatingLabels}
        />
      )}
    </>
  );

  if (visibleNodes.length === 0) {
    return (
      <>
        {homeHeader}
        <div className="flex h-[40vh] flex-col items-center justify-center gap-2 text-[var(--text-tertiary)]">
          <span className="text-[15px]">{t("home.noNodes")}</span>
          <span className="text-[12px]">{t("home.noNodesHint")}</span>
        </div>
      </>
    );
  }

  return (
    <>
      {homeHeader}
      {(showGroupTabs || showHomeSort) && (
        // 分组标签落首列、排序钉在末列右侧；窄屏时两者保持在同一控件栏内。
        <div className={controlsWrapClassName} style={controlsStyle}>
          {showGroupTabs && (
            <GroupTabs
              groups={groupOptions}
              selectedGroup={selectedGroup}
              onSelectGroup={setSelectedGroup}
              onReorder={handleGroupReorder}
              hasSort={showHomeSort}
            />
          )}
          {showHomeSort && <HomeSortControl state={sort} />}
        </div>
      )}
      {showRegionBar && (
        <RegionTabs
          regions={regionOptions}
          selectedRegion={selectedRegion}
          onSelectRegion={setSelectedRegion}
          onReorder={handleRegionReorder}
        />
      )}
      {isList ? <NodeListView uuids={orderedUuids} /> : gridElement}
    </>
  );
}
