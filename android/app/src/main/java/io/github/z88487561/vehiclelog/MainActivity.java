package io.github.z88487561.vehiclelog;

import android.os.Bundle;
import android.util.Log;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;

public class MainActivity extends BridgeActivity {
    // 連續崩潰保護：60 秒內超過 3 次就不再處理，交給系統，避免無限重啟
    private static long windowStart = 0;
    private static int crashes = 0;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // WebView 的渲染程序（網頁）出事時，若沒有人處理，系統會把整個 App 殺掉。
        // 這裡改成重新建立頁面；資料存在 localStorage／IndexedDB 與「文件」備份，不會因此消失。
        getBridge().addWebViewListener(new WebViewListener() {
            @Override
            public boolean onRenderProcessGone(WebView webView, RenderProcessGoneDetail detail) {
                Log.e("VehicleLog", "WebView 渲染程序結束，didCrash=" + detail.didCrash());
                long now = System.currentTimeMillis();
                if (now - windowStart > 60000) { windowStart = now; crashes = 0; }
                if (++crashes > 3) return false;
                runOnUiThread(() -> recreate());
                return true;
            }
        });
    }
}
