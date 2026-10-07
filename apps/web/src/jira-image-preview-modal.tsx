import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from "react";
import { createPortal } from "react-dom";
import { Download, Minus, Plus, RotateCcw, X } from "lucide-react";
import { Button } from "@/components/ui/button";

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 5;
const ZOOM_STEP = 0.25;

function clampZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
}

function zoomLabel(value: number): string {
  return `${Math.round(value * 100)}%`;
}

type JiraImagePreviewModalProps = {
  filename: string;
  previewUrl: string;
  downloadUrl: string;
  onClose: () => void;
};

export function JiraImagePreviewModal({ filename, previewUrl, downloadUrl, onClose }: JiraImagePreviewModalProps) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        setZoom((current) => clampZoom(current + ZOOM_STEP));
      }
      if (event.key === "-") {
        event.preventDefault();
        setZoom((current) => clampZoom(current - ZOOM_STEP));
      }
      if (event.key === "0") {
        event.preventDefault();
        setZoom(1);
        setPan({ x: 0, y: 0 });
      }
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKeyDown);
    closeButtonRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  const changeZoom = (amount: number) => {
    setZoom((current) => {
      const next = clampZoom(current + amount);
      if (next <= 1) setPan({ x: 0, y: 0 });
      return next;
    });
  };

  const resetView = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  const handleWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    changeZoom(event.deltaY > 0 ? -ZOOM_STEP / 2 : ZOOM_STEP / 2);
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (zoom <= 1) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, originX: pan.x, originY: pan.y };
    setDragging(true);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setPan({ x: drag.originX + event.clientX - drag.startX, y: drag.originY + event.clientY - drag.startY });
  };

  const stopDragging = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === event.pointerId && event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    dragRef.current = null;
    setDragging(false);
  };

  return createPortal(
    <div className="jira-image-preview-modal">
      <Button variant="ghost" className="jira-image-preview-modal-backdrop" type="button" aria-label="关闭图片预览" onClick={onClose} />
      <section className="jira-image-preview-modal-dialog" role="dialog" aria-modal="true" aria-label={`图片预览 ${filename}`}>
        <header className="jira-image-preview-modal-header">
          <strong title={filename}>{filename}</strong>
          <div className="jira-image-preview-modal-actions">
            <Button variant="outline" size="icon" type="button" aria-label="缩小图片" title="缩小（-）" onClick={() => changeZoom(-ZOOM_STEP)} disabled={zoom <= MIN_ZOOM}><Minus aria-hidden="true" /></Button>
            <span className="jira-image-preview-zoom-label" aria-live="polite">{zoomLabel(zoom)}</span>
            <Button variant="outline" size="icon" type="button" aria-label="放大图片" title="放大（+）" onClick={() => changeZoom(ZOOM_STEP)} disabled={zoom >= MAX_ZOOM}><Plus aria-hidden="true" /></Button>
            <Button variant="outline" size="sm" type="button" onClick={resetView}><RotateCcw aria-hidden="true" />重置</Button>
            <a className="jira-attachment-download" href={downloadUrl} download={filename}><Download aria-hidden="true" />下载附件</a>
            <Button ref={closeButtonRef} variant="outline" size="icon" className="jira-image-preview-modal-close" type="button" aria-label="关闭图片预览" title="关闭（Esc）" onClick={onClose}><X aria-hidden="true" /></Button>
          </div>
        </header>
        <div className={`jira-image-preview-modal-viewport ${dragging ? "is-dragging" : ""}`} onWheel={handleWheel} onPointerDown={handlePointerDown} onPointerMove={handlePointerMove} onPointerUp={stopDragging} onPointerCancel={stopDragging}>
          <img className="jira-image-preview-modal-image" src={previewUrl} alt={`图片预览 ${filename}`} draggable="false" style={{ transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom})` }} />
        </div>
        <footer className="jira-image-preview-modal-help">滚轮缩放 · 拖动图片 · Esc 关闭</footer>
      </section>
    </div>,
    document.body,
  );
}
