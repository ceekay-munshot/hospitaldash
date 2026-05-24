import { useMemo } from 'react';
import ReactECharts from 'echarts-for-react';
import { formatValue } from '../lib/format';

// Distinct, color-blind-friendly palette for peer overlays
const PALETTE = [
  '#0F6E56', '#185FA5', '#534AB7', '#B45309', '#9F1239',
  '#15803D', '#1E40AF', '#6D28D9', '#9A3412', '#BE185D',
  '#0E7490',
];

export default function TrendChart({
  metricKey,
  meta,
  primaryCompany,      // { slug, name, series: [{ fq, label, value, sources }] }
  peerCompanies,       // optional [{ slug, shortName, series: [...] }]
  height = 380,
}) {
  const option = useMemo(() => {
    const allQuarters = new Set();
    primaryCompany.series.forEach((p) => allQuarters.add(p.fq));
    (peerCompanies || []).forEach((c) => c.series.forEach((p) => allQuarters.add(p.fq)));
    const quarters = [...allQuarters].sort();

    const primarySeries = {
      name: primaryCompany.shortName || primaryCompany.name,
      type: 'line',
      data: quarters.map((fq) => {
        const p = primaryCompany.series.find((s) => s.fq === fq);
        return p ? p.value : null;
      }),
      symbol: 'circle',
      symbolSize: 8,
      lineStyle: { width: 2.5, color: '#18181b' },
      itemStyle: { color: '#18181b' },
      smooth: true,
      z: 10,
      emphasis: { focus: 'series' },
    };

    const peerSeries = (peerCompanies || []).map((c, i) => ({
      name: c.shortName || c.name,
      type: 'line',
      data: quarters.map((fq) => {
        const p = c.series.find((s) => s.fq === fq);
        return p ? p.value : null;
      }),
      symbol: 'circle',
      symbolSize: 4,
      lineStyle: { width: 1.4, color: PALETTE[i % PALETTE.length], opacity: 0.7 },
      itemStyle: { color: PALETTE[i % PALETTE.length] },
      smooth: true,
      emphasis: { focus: 'series' },
    }));

    return {
      animation: true,
      animationDuration: 400,
      grid: { top: 32, right: 40, bottom: 64, left: 72 },
      tooltip: {
        trigger: 'axis',
        confine: true,
        backgroundColor: 'rgba(24,24,27,0.96)',
        borderWidth: 0,
        textStyle: { color: '#fff', fontSize: 12 },
        formatter: (params) => {
          const fq = params[0]?.axisValue;
          const headerStyle = 'font-weight:600;margin-bottom:6px;';
          const rows = params
            .filter((p) => p.value != null)
            .sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
            .map((p) => {
              const fmt = formatValue(p.value, meta.unit);
              return `<div style="display:flex;justify-content:space-between;gap:18px;align-items:center;">
                <span><span style="display:inline-block;width:8px;height:8px;background:${p.color};border-radius:2px;margin-right:6px;"></span>${p.seriesName}</span>
                <span style="font-variant-numeric:tabular-nums;">${fmt.display}${fmt.unitLabel}</span>
              </div>`;
            })
            .join('');
          return `<div style="${headerStyle}">${fq}</div>${rows}`;
        },
      },
      legend: peerCompanies && peerCompanies.length > 0
        ? {
            type: 'scroll',
            bottom: 8,
            textStyle: { color: '#52525b', fontSize: 11 },
            itemWidth: 16,
            itemHeight: 4,
            data: [primarySeries.name, ...peerSeries.map((s) => s.name)],
          }
        : { show: false },
      xAxis: {
        type: 'category',
        data: quarters,
        axisLabel: {
          fontSize: 11,
          color: '#71717a',
          rotate: quarters.length > 8 ? 35 : 0,
          interval: 0,
        },
        axisLine: { lineStyle: { color: '#e5e7eb' } },
        axisTick: { show: false },
      },
      yAxis: {
        type: 'value',
        scale: true,
        axisLabel: {
          fontSize: 11,
          color: '#71717a',
          formatter: (v) => {
            const f = formatValue(v, meta.unit);
            return f.display.replace(/^₹/, '₹');
          },
        },
        splitLine: { lineStyle: { color: '#f4f4f5' } },
        axisLine: { show: false },
        axisTick: { show: false },
      },
      series: [primarySeries, ...peerSeries],
    };
  }, [metricKey, meta, primaryCompany, peerCompanies]);

  return (
    <ReactECharts
      option={option}
      style={{ height, width: '100%' }}
      opts={{ renderer: 'canvas' }}
      notMerge
    />
  );
}
