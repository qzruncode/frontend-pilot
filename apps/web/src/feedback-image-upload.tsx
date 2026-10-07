import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type ReactNode } from "react";
import { ImagePlus, X } from "lucide-react";
import { FEEDBACK_MAX_ATTACHMENT_BYTES, FEEDBACK_MAX_ATTACHMENTS, FeedbackImageMimeTypeSchema } from "@contracts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type FeedbackImageItem = {
  id: string;
  file: File;
  previewUrl: string;
};

type FeedbackImageUploadProps = {
  children: ReactNode;
  disabled: boolean;
  resetToken: number;
  onFilesChange: (files: File[]) => void;
  onInteraction: () => void;
};

function imageValidationError(file: File): string | null {
  if (!FeedbackImageMimeTypeSchema.safeParse(file.type).success) return "仅支持 JPG、PNG、GIF 或 WebP 图片。";
  if (file.size > FEEDBACK_MAX_ATTACHMENT_BYTES) return "单张图片不能超过 5 MB。";
  return null;
}

function revokeImagePreviews(images: FeedbackImageItem[]): void {
  images.forEach((image) => URL.revokeObjectURL(image.previewUrl));
}

function formatFileSize(size: number): string {
  return size >= 1024 * 1024 ? `${(size / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(size / 1024))} KB`;
}

function clipboardImageName(file: File): string {
  if (file.name.trim()) return file.name;
  const extension = file.type.split("/", 2)[1] === "jpeg" ? "jpg" : file.type.split("/", 2)[1] || "png";
  return `pasted-image-${Date.now()}.${extension}`;
}

export function FeedbackImageUpload({ children, disabled, resetToken, onFilesChange, onInteraction }: FeedbackImageUploadProps) {
  const [images, setImages] = useState<FeedbackImageItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const imagesRef = useRef<FeedbackImageItem[]>([]);
  const resetTokenRef = useRef(resetToken);

  useEffect(() => () => revokeImagePreviews(imagesRef.current), []);
  const replaceImages = useCallback((next: FeedbackImageItem[]) => {
    imagesRef.current = next;
    setImages(next);
    onFilesChange(next.map((image) => image.file));
  }, [onFilesChange]);

  const addImageFiles = useCallback((selectedFiles: File[]) => {
    if (disabled || selectedFiles.length === 0) return;
    const currentImages = imagesRef.current;
    const remaining = FEEDBACK_MAX_ATTACHMENTS - currentImages.length;
    const nextImages = selectedFiles.slice(0, Math.max(0, remaining)).map((file) => ({
      id: `${file.name}-${file.lastModified}-${crypto.randomUUID()}`,
      file,
      previewUrl: URL.createObjectURL(file),
    }));
    const invalidMessage = selectedFiles
      .map(imageValidationError)
      .find((message): message is string => message !== null);
    const acceptedImages = nextImages.filter((image) => imageValidationError(image.file) === null);
    const limitMessage = selectedFiles.length > remaining ? `最多上传 ${FEEDBACK_MAX_ATTACHMENTS} 张图片。` : null;
    if (acceptedImages.length > 0) replaceImages([...currentImages, ...acceptedImages]);
    revokeImagePreviews(nextImages.filter((image) => !acceptedImages.includes(image)));
    setError(invalidMessage ?? limitMessage);
    onInteraction();
  }, [disabled, onInteraction, replaceImages]);

  const handlePaste = useCallback((event: ClipboardEvent<HTMLDivElement>) => {
    const imageFiles = Array.from(event.clipboardData?.items ?? [])
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null)
      .map((file) => {
        const name = clipboardImageName(file);
        return file.name === name ? file : new File([file], name, { type: file.type, lastModified: file.lastModified });
      });
    if (imageFiles.length === 0) return;
    event.preventDefault();
    addImageFiles(imageFiles);
  }, [addImageFiles]);

  useEffect(() => {
    if (resetToken === resetTokenRef.current) return;
    resetTokenRef.current = resetToken;
    revokeImagePreviews(imagesRef.current);
    imagesRef.current = [];
    setImages([]);
    setError(null);
    onFilesChange([]);
  }, [resetToken]);

  const handleImageChange = (files: FileList | null, input: HTMLInputElement) => {
    const selectedFiles = Array.from(files ?? []);
    input.value = "";
    addImageFiles(selectedFiles);
  };

  const removeImage = (id: string) => {
    const removed = imagesRef.current.find((image) => image.id === id);
    if (removed) URL.revokeObjectURL(removed.previewUrl);
    replaceImages(imagesRef.current.filter((image) => image.id !== id));
    setError(null);
    onInteraction();
  };

  return (
    <div className="feedback-comment-composer" onPaste={handlePaste}>
      {children}
      {images.length > 0 && (
        <div className="feedback-image-previews" aria-label="待上传图片">
          {images.map((image) => (
            <div className="feedback-image-preview" key={image.id}>
              <img src={image.previewUrl} alt={`待上传图片：${image.file.name}`} />
              <Button
                className="feedback-image-remove"
                variant="outline"
                size="icon"
                type="button"
                aria-label={`移除 ${image.file.name}`}
                title={`移除 ${image.file.name}`}
                onClick={() => removeImage(image.id)}
              >
                <X aria-hidden="true" />
              </Button>
              <span title={image.file.name}><ImagePlus aria-hidden="true" />{image.file.name} · {formatFileSize(image.file.size)}</span>
            </div>
          ))}
        </div>
      )}
      <div className="feedback-comment-toolbar">
        <label className="feedback-comment-upload" htmlFor="feedback-images">
          <ImagePlus aria-hidden="true" />添加截图
        </label>
        <Input
          id="feedback-images"
          className="feedback-comment-file-input"
          type="file"
          accept={FeedbackImageMimeTypeSchema.options.join(",")}
          multiple
          disabled={disabled || images.length >= FEEDBACK_MAX_ATTACHMENTS}
          onChange={(event) => handleImageChange(event.target.files, event.currentTarget)}
        />
        <small>在输入框内直接粘贴截图，或点击添加截图；最多 {FEEDBACK_MAX_ATTACHMENTS} 张，每张不超过 {formatFileSize(FEEDBACK_MAX_ATTACHMENT_BYTES)}。</small>
      </div>
      {error && <p className="feedback-validation-error" role="alert">{error}</p>}
    </div>
  );
}
