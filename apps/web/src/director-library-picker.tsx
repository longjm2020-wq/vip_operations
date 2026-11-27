import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Alert, Checkbox, Modal, Spin } from "antd";
import {
  directorAssetLimit,
  type DirectorAsset,
} from "../../../packages/contracts/src/director";
import { inferDirectorRole } from "../../../packages/contracts/src/director-intent";
import {
  DirectorAssetRoleBadge,
  DirectorAssetAuthorization,
} from "./director-asset-role";
import { libraryDirectorAsset, libraryDirectorFiles } from "./director-project";

export function DirectorLibraryPicker({
  userId,
  assets,
  brief,
  onAdd,
  onClose,
}: {
  userId: string;
  assets: DirectorAsset[];
  brief: string;
  onAdd: (items: DirectorAsset[]) => void;
  onClose: () => void;
}) {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const library = useQuery({
    queryKey: ["director-library", userId],
    queryFn: ({ signal }) => libraryDirectorFiles(signal),
  });
  const selected = new Set(selectedIds);
  const existing = new Map(
    assets.filter((item) => item.fileId).map((item) => [item.fileId, item]),
  );
  const files = library.data ?? [];
  const additions = files.filter(
    (file) => selected.has(file.id) && !existing.has(file.id),
  );
  const countByKind = new Map<string, number>();
  for (const file of [...assets, ...additions]) {
    const kind = file.mime.split("/")[0];
    countByKind.set(kind, (countByKind.get(kind) ?? 0) + 1);
  }
  const space = directorAssetLimit - assets.length;
  return (
    <Modal
      title="从工作台文件选择"
      open
      onCancel={onClose}
      okText="加入项目"
      cancelText="取消"
      okButtonProps={{
        disabled: !additions.length || additions.length > space,
      }}
      onOk={() => {
        onAdd(
          additions.map((file) =>
            libraryDirectorAsset(
              file,
              brief,
              countByKind.get(file.mime.split("/")[0]) === 1,
            ),
          ),
        );
        onClose();
      }}
    >
      {library.isLoading ? (
        <Spin />
      ) : library.isError ? (
        <Alert
          type="error"
          title={
            library.error instanceof Error
              ? library.error.message
              : "读取工作台文件失败。"
          }
        />
      ) : files.length ? (
        <>
          <p className="director-muted">
            勾选文件后可核对建议用途，加入项目后也可修改。
          </p>
          <Checkbox.Group
            value={selectedIds}
            onChange={setSelectedIds}
            className="director-library-options"
          >
            {files.map((file) => {
              const saved = existing.get(file.id);
              const count = countByKind.get(file.mime.split("/")[0]) ?? 0;
              // For an unchecked file, show its suggested role if it were added to this selection.
              const onlyOfKind = selected.has(file.id)
                ? count === 1
                : count === 0;
              const role =
                saved?.role ??
                inferDirectorRole(file.name, file.mime, brief, onlyOfKind);
              return (
                <Checkbox
                  key={file.id}
                  value={file.id}
                  disabled={
                    !!saved ||
                    (!selected.has(file.id) && additions.length >= space)
                  }
                >
                  <span className="director-library-file">
                    <span className="director-library-filename">
                      {file.name}
                    </span>
                    <DirectorAssetRoleBadge role={role} />
                    <DirectorAssetAuthorization asset={saved ?? { role }} />
                    {saved && <small>已在项目中</small>}
                  </span>
                </Checkbox>
              );
            })}
          </Checkbox.Group>
        </>
      ) : (
        <p className="director-muted">工作台中暂无可用文件。</p>
      )}
    </Modal>
  );
}
