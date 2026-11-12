"use client";
import { useEffect, useRef, useState } from "react";
export function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  const [open, setOpen] = useState(false),
    [filter, setFilter] = useState(""),
    [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null),
    trigger = useRef<HTMLButtonElement>(null),
    input = useRef<HTMLInputElement>(null);
  const visible = options.filter((option) => option.label.includes(filter));
  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    const close = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const pick = (next: string) => {
    onChange(next);
    setOpen(false);
    setFilter("");
    trigger.current?.focus();
  };
  return (
    <div
      className="desktop-select"
      ref={root}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          setOpen(false);
          trigger.current?.focus();
        }
      }}
    >
      <button
        ref={trigger}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
          setFilter("");
          setActive(0);
        }}
      >
        {options.find((option) => option.value === value)?.label ?? label} ⌄
      </button>
      {open && (
        <div className="desktop-select-popover">
          <input
            ref={input}
            aria-label={`筛选${label}`}
            placeholder="筛选选项…"
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                setActive(
                  (i) =>
                    (i + (e.key === "ArrowDown" ? 1 : -1) + visible.length) %
                    (visible.length || 1),
                );
              }
              if (e.key === "Enter" && visible[active]) {
                e.preventDefault();
                pick(visible[active].value);
              }
            }}
          />
          <div role="listbox" aria-label={label}>
            {visible.map((option, i) => (
              <button
                role="option"
                aria-selected={option.value === value}
                className={i === active ? "keyboard-active" : ""}
                key={option.value}
                onClick={() => pick(option.value)}
              >
                {option.label}
                {option.value === value ? " ✓" : ""}
              </button>
            ))}
          </div>
          {!visible.length && <p>没有匹配选项</p>}
          <button
            className="desktop-quiet"
            onClick={() => pick(options[0].value)}
          >
            清除筛选
          </button>
        </div>
      )}
    </div>
  );
}
