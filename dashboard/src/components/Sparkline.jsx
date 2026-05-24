import { useMemo } from 'react';
import ReactECharts from 'echarts-for-react';

export default function Sparkline({ series, color = '#52525b', height = 36 }) {
  const option = useMemo(() => {
    if (!series || series.length < 2) return null;
    const data = series.map((p) => [p.label, p.value]);
    return {
      animation: false,
      grid: { top: 4, right: 4, bottom: 4, left: 4 },
      xAxis: { type: 'category', show: false, boundaryGap: false },
      yAxis: { type: 'value', show: false, scale: true },
      tooltip: {
        trigger: 'axis',
        confine: true,
        backgroundColor: 'rgba(24,24,27,0.92)',
        borderWidth: 0,
        textStyle: { color: '#fff', fontSize: 11 },
        formatter: (params) => {
          const p = params[0];
          return `<div style="font-weight:500">${p.axisValue}</div><div style="font-variant-numeric:tabular-nums">${formatTooltip(p.value[1])}</div>`;
        },
      },
      series: [
        {
          type: 'line',
          data,
          showSymbol: false,
          smooth: true,
          lineStyle: { color, width: 1.5 },
          areaStyle: {
            opacity: 0.12,
            color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [
              { offset: 0, color },
              { offset: 1, color: color + '00' },
            ]},
          },
        },
      ],
    };
  }, [series, color]);

  if (!option) return <div style={{ height }} />;

  return (
    <ReactECharts
      option={option}
      style={{ height, width: '100%' }}
      opts={{ renderer: 'svg' }}
      notMerge
    />
  );
}

function formatTooltip(v) {
  if (v == null) return '—';
  if (Math.abs(v) >= 1e5) return v.toLocaleString('en-IN');
  if (Math.abs(v) < 10) return v.toFixed(2);
  return v.toLocaleString('en-IN', { maximumFractionDigits: 1 });
}
