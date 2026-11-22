"use client";

import { useEffect, useId, useRef } from "react";
import { X } from "lucide-react";

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  maxWidth?: string;
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

export default function Modal({ isOpen, onClose, title, children, maxWidth = "620px" }: ModalProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const titleId = useId();

  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  useEffect(() => {
    if (!isOpen) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const focusables = () => Array.from(dialog?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter((el) => el.getClientRects().length > 0);

    // Move focus into the dialog: first control in the body, else the close button, else the dialog.
    const items = focusables();
    const first = items.find((el) => !el.dataset.modalClose) ?? items[0];
    (first ?? dialog)?.focus();

    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.stopPropagation(); onCloseRef.current(); return; }
      if (event.key !== "Tab" || !dialog) return;
      // Keep Tab and Shift+Tab inside the dialog.
      const current = focusables();
      if (!current.length) { event.preventDefault(); dialog.focus(); return; }
      const firstItem = current[0];
      const lastItem = current[current.length - 1];
      if (event.shiftKey && (document.activeElement === firstItem || document.activeElement === dialog)) { event.preventDefault(); lastItem.focus(); }
      else if (!event.shiftKey && document.activeElement === lastItem) { event.preventDefault(); firstItem.focus(); }
    };

    document.addEventListener("keydown", handleKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", handleKey);
      document.body.style.overflow = previousOverflow;
      // Return focus to whatever opened the dialog.
      previouslyFocused?.focus();
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const maxWidthClass =
    maxWidth === "720px" ? "max-w-[720px]" :
    maxWidth === "640px" ? "max-w-[640px]" :
    maxWidth === "440px" ? "max-w-[440px]" :
    "max-w-[620px]";

  return (
    <div
      ref={overlayRef}
      onMouseDown={(e) => {
        if (e.target === overlayRef.current) onClose();
      }}
      className="fixed inset-0 z-[9999] flex items-center justify-center p-4 bg-black/85 backdrop-blur-[6px]"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`w-full bg-surface-1 border border-[#2a2a2e] rounded-2xl shadow-2xl overflow-hidden flex flex-col outline-none motion-safe:animate-[modalSlideIn_0.3s_cubic-bezier(0.16,1,0.3,1)_forwards] ${maxWidthClass}`}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4.5 border-b border-subtle bg-field">
          <h2 id={titleId} className="m-0 font-headline font-bold text-[12px] text-action tracking-[0.1em] uppercase">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close dialog"
            data-modal-close="true"
            className="w-[30px] h-[30px] rounded-lg bg-transparent border border-[#2a2a2e] text-fg-muted hover:border-action hover:text-action focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-action transition-colors flex items-center justify-center cursor-pointer"
          >
            <X size={14} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>

        {/* Body */}
        <div className="p-6 overflow-y-auto max-h-[80vh] text-fg-secondary">
          {children}
        </div>
      </div>

      <style>{`
        @keyframes modalSlideIn {
          from { opacity: 0; transform: translateY(-12px) scale(0.97); }
          to   { opacity: 1; transform: translateY(0) scale(1); }
        }
      `}</style>
    </div>
  );
}
