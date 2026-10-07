import { Trash2 } from "lucide-react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

type AssistantDeleteDialogProps = {
  open: boolean;
  title: string;
  description: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
};

export function AssistantDeleteDialog({ open, title, description, busy, onCancel, onConfirm }: AssistantDeleteDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen && !busy) onCancel(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <div className="assistant-delete-dialog-icon"><Trash2 aria-hidden="true" /></div>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel asChild>
            <Button variant="ghost" type="button" disabled={busy}>取消</Button>
          </AlertDialogCancel>
          <Button variant="destructive" type="button" disabled={busy} onClick={onConfirm}>
            <Trash2 aria-hidden="true" />{busy ? "删除中…" : "确认删除"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
