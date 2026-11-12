"use client";
import { useRef, type ReactNode } from "react";
export function PageHeading({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <header className="desktop-heading">
      <div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {children}
    </header>
  );
}
export function SettingRow({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="desktop-setting-row">
      <div>
        <h3>{title}</h3>
        <p>{description}</p>
      </div>
      <div className="desktop-setting-control">{children}</div>
    </div>
  );
}
export function SelectAll({
  checked,
  mixed,
  onChange,
}: {
  checked: boolean;
  mixed: boolean;
  onChange: (selected: boolean) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <input
      ref={(node) => {
        ref.current = node;
        if (node) node.indeterminate = mixed;
      }}
      type="checkbox"
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
      aria-label="选择当前筛选结果"
    />
  );
}
export function Empty({ children }: { children: ReactNode }) {
  return <div className="desktop-empty">{children}</div>;
}
export const bytes = (value: number) =>
  value < 1024 * 1024
    ? `${Math.round(value / 1024)} KB`
    : value < 1024 ** 3
      ? `${(value / 1024 ** 2).toFixed(1)} MB`
      : `${(value / 1024 ** 3).toFixed(2)} GB`;
