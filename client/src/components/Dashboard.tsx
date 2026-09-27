// Dashboard (Yfirlit): period reports, stock on hand, weekly summary.
import { CHANGE_TYPES, PERIOD_KEYS, type AppState, type PeriodReport, type Settings } from '../../../shared/types';
import { t, useStore } from '../store';
import { fmtMoney, fmtNumber } from '../util';
import { WeeklyCard, shouldShowWeekly } from './Weekly';

export function Dashboard(props: { view: AppState }) {
  const { reports } = useStore();
  const s = t();
  const { settings, stock } = props.view;
  const showWeeklyTop = reports ? shouldShowWeekly(reports) : false;
  const hasWeekly = !!reports?.weekly && (reports.weekly.diapers > 0 || reports.weekly.prevDiapers > 0);

  return (
    <div class="screen">
      {reports && showWeeklyTop && <WeeklyCard reports={reports} settings={settings} dismissible />}

      {!reports ? (
        <section class="card">
          <p class="muted">{s.loading}</p>
        </section>
      ) : (
        PERIOD_KEYS.map((k) => <PeriodCard key={k} report={reports.periods[k]} settings={settings} />)
      )}

      <section class="card">
        <h2>{s.stock}</h2>
        {stock.length === 0 ? (
          <p class="muted">{s.noStock}</p>
        ) : (
          <table class="table">
            <thead>
              <tr>
                <th>{s.size}</th>
                <th class="num">{s.stockBought}</th>
                <th class="num">{s.stockUsed}</th>
                <th class="num">{s.stockOnHand}</th>
              </tr>
            </thead>
            <tbody>
              {stock.map((row) => (
                <tr key={row.size} class={row.onHand < 0 ? 'negative' : undefined}>
                  <td>
                    <span class="size-badge">{row.size}</span>
                  </td>
                  <td class="num">{row.bought}</td>
                  <td class="num">{row.used}</td>
                  <td class="num strong">
                    {row.onHand < 0 && '⚠ '}
                    {row.onHand}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {stock.some((r) => r.onHand < 0) && <p class="warning small">⚠ {s.stockNegative}</p>}
      </section>

      {reports && hasWeekly && !showWeeklyTop && <WeeklyCard reports={reports} settings={settings} />}
    </div>
  );
}

function PeriodCard(props: { report: PeriodReport; settings: Settings }) {
  const s = t();
  const r = props.report;
  if (!r) return null;
  const sizes = Object.entries(r.bySize).filter(([, n]) => n > 0);
  const types = CHANGE_TYPES.filter((ty) => (r.byType?.[ty] ?? 0) > 0);
  return (
    <section class="card period">
      <h2>{s.periods[r.key]}</h2>
      <div class="stats">
        <Stat label={s.diapers} value={String(r.diapers)} />
        <Stat
          label={s.cost}
          value={`${r.costEstimated ? '≈ ' : ''}${fmtMoney(r.costMinor, props.settings)}`}
          title={r.costEstimated ? s.estimatedNote : undefined}
        />
        <Stat label={s.avgPerDay} value={fmtNumber(r.avgPerDay, 1)} />
        <Stat label={s.spentOnPacks} value={fmtMoney(r.spentMinor, props.settings)} />
      </div>
      {(sizes.length > 0 || types.length > 0) && (
        <div class="breakdown">
          {sizes.length > 0 && (
            <div class="tags" aria-label={s.bySize}>
              <span class="tag-label">{s.bySize}:</span>
              {sizes.map(([size, n]) => (
                <span class="tag" key={size}>
                  <span class="size-badge small">{size}</span> {n}
                </span>
              ))}
            </div>
          )}
          {types.length > 0 && (
            <div class="tags" aria-label={s.byType}>
              <span class="tag-label">{s.byType}:</span>
              {types.map((ty) => (
                <span class="tag" key={ty}>
                  <span class={`type-dot t-${ty}`} /> {s.types[ty]} {r.byType[ty]}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
      {r.costEstimated && <p class="muted small">{s.estimatedNote}</p>}
    </section>
  );
}

function Stat(props: { label: string; value: string; title?: string }) {
  return (
    <div class="stat" title={props.title}>
      <div class="stat-value">{props.value}</div>
      <div class="stat-label">{props.label}</div>
    </div>
  );
}
