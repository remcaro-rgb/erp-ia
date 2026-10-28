import { authCopy } from "@/lib/auth/copy";

export function Brand() {
  return (
    <div className="flex items-center gap-2">
      <i className="inline-block size-[26px] rounded-[7px] bg-blue-400" aria-hidden />
      <span className="text-lg font-bold">{authCopy.brand}</span>
    </div>
  );
}
