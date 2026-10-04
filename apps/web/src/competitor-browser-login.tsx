import { useEffect, useRef, useState } from "react";
import { Alert, Button, Modal, Tag } from "antd";
import { captureBookmarkUrl } from "./competitor-capture";
import { useUser, when } from "./shared";

type LoginCheck = {
  status: "LOGGED_IN" | "LOGGED_OUT" | "UNKNOWN";
  checkedAt: number;
};
const lifetime = 30 * 60 * 1000;
export function CompetitorBrowserLogin({ sourceUrl }: { sourceUrl: string }) {
  const user = useUser(),
    key = `vip-browser-login:${user.id}`;
  const [check, setCheck] = useState<LoginCheck>(),
    [open, setOpen] = useState(false),
    [blocked, setBlocked] = useState(false);
  const popup = useRef<Window | null>(null),
    bookmark = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(key) || "null");
      if (
        saved &&
        Date.now() - saved.checkedAt < lifetime &&
        ["LOGGED_IN", "LOGGED_OUT", "UNKNOWN"].includes(saved.status)
      )
        setCheck(saved);
    } catch {
      /* A malformed local status must not imply a valid login. */
    }
    const receive = (event: MessageEvent) => {
      if (
        event.source !== popup.current ||
        ![
          "https://category.vip.com",
          "https://detail.vip.com",
          "https://passport.vip.com",
        ].includes(event.origin) ||
        event.data?.kind !== "XUTI_VIP_BROWSER_LOGIN" ||
        !["LOGGED_IN", "LOGGED_OUT", "UNKNOWN"].includes(event.data.status)
      )
        return;
      const next: LoginCheck = {
        status: event.data.status,
        checkedAt: Date.now(),
      };
      setCheck(next);
      sessionStorage.setItem(key, JSON.stringify(next));
    };
    window.addEventListener("message", receive);
    const expire = setInterval(
      () =>
        setCheck((current) =>
          current && Date.now() - current.checkedAt >= lifetime
            ? undefined
            : current,
        ),
      30000,
    );
    return () => {
      window.removeEventListener("message", receive);
      clearInterval(expire);
    };
  }, [key]);
  function login() {
    // The popup goes directly to VIP. Only a boolean DOM check can be returned
    // by our bookmark; no cookie, account identifier or credential is exported.
    popup.current = window.open(
      sourceUrl,
      "xuti-vip-browser-login",
      "popup,width=1080,height=760",
    );
    setBlocked(!popup.current);
    setCheck(undefined);
    sessionStorage.removeItem(key);
    setOpen(true);
  }
  const loggedIn = check?.status === "LOGGED_IN",
    loggedOut = check?.status === "LOGGED_OUT";
  return (
    <>
      <span className="competitor-browser-login">
        <Tag
          color={loggedIn ? "success" : loggedOut ? "warning" : "default"}
          title={
            check
              ? `本机核验于 ${when(check.checkedAt)}，30分钟后需重新核验；不代表后台服务器登录`
              : "尚未核验当前浏览器；后台服务器使用独立会话"
          }
        >
          {loggedIn
            ? "唯品会 · 本机已登录"
            : loggedOut
              ? "唯品会 · 本机未登录"
              : "唯品会 · 本机登录待核验"}
        </Tag>
        <Button type="link" size="small" onClick={login}>
          {loggedIn ? "核验登录" : "登录唯品会"}
        </Button>
      </span>
      <Modal
        title="唯品会本机登录"
        open={open}
        onCancel={() => setOpen(false)}
        footer={<Button onClick={() => setOpen(false)}>返回竞品分析</Button>}
      >
        {blocked && (
          <Alert
            type="warning"
            showIcon
            title="浏览器拦截了登录窗口"
            description="请允许本站弹出窗口，再点击下方登录按钮。"
          />
        )}
        <p>在弹出的唯品会窗口扫码登录。若已登录，会直接显示品牌销量榜。</p>
        <Button onClick={login}>打开登录窗口</Button>
        <p>
          将下面按钮拖到书签栏。登录后，在刚打开的唯品会窗口点击该书签，核验本机登录状态并下载当前页公开商品
          JSON，再回到「导入数据」上传。
        </p>
        <a
          ref={(element) => {
            bookmark.current = element;
            if (element)
              element.setAttribute(
                "href",
                captureBookmarkUrl(window.location.origin),
              );
          }}
          className="competitor-bookmark"
          draggable
          onClick={(event) => event.preventDefault()}
        >
          核验登录并采集商品
        </a>
        <p>
          {loggedIn
            ? `本机登录已核验 · ${when(check.checkedAt)}`
            : loggedOut
              ? "当前窗口尚未登录"
              : "等待在唯品会窗口点击采集书签核验"}
        </p>
        <Alert
          type="info"
          showIcon
          title="登录状态仅对应当前浏览器"
          description="只核验已显示的登录状态，不读取、上传或保存 Cookie 和密码。本机登录不会自动授权后台采集服务器。"
        />
      </Modal>
    </>
  );
}
