// Weekly summary card ("Síðasta vika: N bleyjur, X kr.").
import type { ReportsResponse, Settings } from '../../../shared/types';
import { dismissWeekly, t, weeklyDismissedFor } from '../store';
import { fmtMoney } from '../util';

/** Show the prominent card once per week until dismissed (keyed by weekly.weekStart). */
export function shouldShowWeekly(reports: ReportsResponse): boolean {
  const w = reports.weekly;
  if (!w || (w.diapers === 0 && w.prevDiapers === 0)) return false;
  return weeklyDismissedFor() !== w.weekStart;
}

export function WeeklyCard(props: { reports: ReportsResponse; settings: Settings; dismissible?: boolean }) {
  const s = t();
  const w = props.reports.weekly;
  const diff = w.diapers - w.prevDiapers;
  const costDiff = w.costMinor - w.prevCostMinor;
  const money = (m: number) => fmtMoney(m, props.settings);
  return (
    <section class={props.dismissible ? 'card weekly highlight' : 'card weekly'}>
      <div class="row">
        <h2 class="grow">{s.weeklyTitle}</h2>
        {props.dismissible && (
          <button type="button" class="btn secondary small" onClick={() => dismissWeekly(w.weekStart)}>
            {s.dismiss}
          </button>
        )}
      </div>
      <p class="weekly-main">{s.weeklyLine(w.diapers, `${w.costEstimated ? '≈ ' : ''}${money(w.costMinor)}`)}</p>
      <p class={diff > 0 ? 'trend up' : diff < 0 ? 'trend down' : 'trend'}>
        {diff > 0 ? '▲ ' : diff < 0 ? '▼ ' : '= '}
        {diff > 0 ? s.weeklyMore(diff) : diff < 0 ? s.weeklyFewer(-diff) : s.weeklySame}
        {costDiff !== 0 && ` (${costDiff > 0 ? '+' : '−'}${money(Math.abs(costDiff))})`}
      </p>
      <p class="muted small">{s.weeklyCompare(w.prevDiapers, money(w.prevCostMinor))}</p>
    </section>
  );
}
