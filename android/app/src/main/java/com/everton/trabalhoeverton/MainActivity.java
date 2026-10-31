package com.everton.trabalhoeverton;

import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Base64;
import com.getcapacitor.BridgeActivity;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;

public class MainActivity extends BridgeActivity {
    // Guarda o motivo exato se a conversão da foto falhar — usado só pro
    // diagnóstico temporário que aparece dentro da nota criada.
    private String lastImageError;

    // Proteção contra o mesmo compartilhamento ser processado duas vezes: em
    // alguns aparelhos/launchers Android, o mesmo "Compartilhar" pode chegar
    // tanto em onCreate() quanto em onNewIntent() (ex.: o app já tinha uma
    // tarefa em segundo plano). Guardamos uma "assinatura" do último
    // compartilhamento tratado e ignoramos uma repetição idêntica em
    // seguida — evita a nota duplicada, sem afetar dois compartilhamentos
    // diferentes feitos de propósito, um logo após o outro.
    private String lastShareSignature;
    private long lastShareAtMs;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Registra o plugin do alarme nativo ANTES do super.onCreate — é
        // assim que o Capacitor exige que plugins customizados sejam
        // ligados ao app.
        registerPlugin(AlarmPlugin.class);
        registerPlugin(FileOpenerPlugin.class);
        super.onCreate(savedInstanceState);
        // Impede que a configuração de "Tamanho da fonte" do próprio Android
        // (Configurações > Tela > Tamanho da fonte) deixe o texto do app
        // maior do que o planejado. É por isso que no navegador (Chrome)
        // ficava normal, mas no app instalado ficava grande — o Chrome
        // ignora essa configuração do sistema, o WebView do app não ignorava.
        getBridge().getWebView().getSettings().setTextZoom(100);

        // Se o app foi aberto A PARTIR de um "Compartilhar" (WhatsApp,
        // Galeria, etc.), captura o conteúdo aqui.
        handleShareIntent(getIntent());
    }

    // Chamado quando o app JÁ ESTÁ ABERTO e a pessoa compartilha algo pra ele
    // de novo (o Android reaproveita a mesma tela, em vez de abrir outra).
    @Override
    public void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleShareIntent(intent);
    }

    // Recebe conteúdo compartilhado de outros apps (WhatsApp, Galeria, etc.)
    // via "Compartilhar" — texto e/ou foto — e entrega pro JavaScript do app
    // exatamente do mesmo jeito que o ShareReceiver.tsx já faz (mesma chave
    // no sessionStorage), pra reaproveitar a lógica que já existe de criar
    // uma nota nova a partir disso.
    private void handleShareIntent(Intent intent) {
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction())) return;

        String text = intent.getStringExtra(Intent.EXTRA_TEXT);
        String subject = intent.getStringExtra(Intent.EXTRA_SUBJECT);
        Uri imageUri = getStreamExtra(intent);

        // Confere ANTES de decodificar a foto (que é um trabalho pesado) se
        // esse exato compartilhamento (mesmo texto + mesma foto) já foi
        // tratado há poucos segundos — se for repetição, ignora.
        String signature = (text == null ? "" : text) + "|" + (subject == null ? "" : subject) + "|" + (imageUri == null ? "" : imageUri.toString());
        long now = System.currentTimeMillis();
        if (signature.equals(lastShareSignature) && (now - lastShareAtMs) < 4000) {
            return;
        }
        lastShareSignature = signature;
        lastShareAtMs = now;

        String imageDataUrl = null;
        if (imageUri != null) {
            imageDataUrl = uriToBase64DataUrl(imageUri);
        }

        // Nada útil pra compartilhar (não era texto nem imagem reconhecida)
        if ((text == null || text.trim().isEmpty()) && imageDataUrl == null) return;

        JSONObject payload = new JSONObject();
        try {
            payload.put("title", subject != null ? subject : "");
            payload.put("content", text != null ? text : "");
            payload.put("image", imageDataUrl != null ? imageDataUrl : JSONObject.NULL);
        } catch (Exception e) {
            return;
        }

        // Escreve no sessionStorage com a MESMA chave que o ShareReceiver.tsx
        // (compartilhamento pelo navegador/PWA) já usa, e avisa o app com um
        // evento — assim funciona tanto se o app já estava aberto quanto se
        // acabou de abrir por causa do compartilhamento.
        String js =
            "try {"
            + "  sessionStorage.setItem('shared_note_data', JSON.stringify(" + payload.toString() + "));"
            + "  window.dispatchEvent(new Event('shared-note-ready'));"
            + "} catch (e) {}";

        runOnUiThread(() -> {
            if (getBridge() != null && getBridge().getWebView() != null) {
                getBridge().getWebView().evaluateJavascript(js, null);
            }
        });
    }

    // Lê o EXTRA_STREAM (a foto/arquivo compartilhado) do jeito certo pra
    // cada versão do Android — a partir do Android 13 (API 33), o método
    // antigo de ler isso foi descontinuado e pode se comportar diferente.
    @SuppressWarnings("deprecation")
    private Uri getStreamExtra(Intent intent) {
        if (Build.VERSION.SDK_INT >= 33) {
            return intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri.class);
        }
        return intent.getParcelableExtra(Intent.EXTRA_STREAM);
    }

    // Lê os bytes de uma foto compartilhada (content://...) e transforma em
    // "data:image/jpeg;base64,...". Duas melhorias importantes aqui:
    // 1) Não desiste mais só porque o tipo de arquivo relatado pelo app de
    //    origem (WhatsApp, Galeria, etc.) não vem exatamente como
    //    "image/...": tenta decodificar de qualquer jeito, e só desiste se
    //    a decodificação falhar de verdade.
    // 2) Decodifica a foto JÁ REDUZIDA (em vez de carregar em tamanho
    //    original na memória pra só depois reduzir) — evita falhar em fotos
    //    grandes de câmera por falta de memória.
    private String uriToBase64DataUrl(Uri uri) {
        try {
            int maxDimension = 1000;

            // 1ª passada: só lê as dimensões da foto, sem carregar os pixels
            BitmapFactory.Options bounds = new BitmapFactory.Options();
            bounds.inJustDecodeBounds = true;
            InputStream boundsInput = getContentResolver().openInputStream(uri);
            if (boundsInput == null) { lastImageError = "não consegui abrir o arquivo (openInputStream nulo)"; return null; }
            BitmapFactory.decodeStream(boundsInput, null, bounds);
            boundsInput.close();
            if (bounds.outWidth <= 0 || bounds.outHeight <= 0) { lastImageError = "não é uma imagem válida (dimensões zero)"; return null; }

            // Calcula de quanto reduzir já na hora de decodificar
            int sample = 1;
            while ((bounds.outWidth / sample) > maxDimension * 2 || (bounds.outHeight / sample) > maxDimension * 2) {
                sample *= 2;
            }

            BitmapFactory.Options decodeOpts = new BitmapFactory.Options();
            decodeOpts.inSampleSize = sample;
            InputStream input = getContentResolver().openInputStream(uri);
            if (input == null) { lastImageError = "não consegui reabrir o arquivo pra decodificar"; return null; }
            Bitmap original = BitmapFactory.decodeStream(input, null, decodeOpts);
            input.close();
            if (original == null) { lastImageError = "decodeStream retornou nulo (formato não suportado?)"; return null; }

            Bitmap resized = original;
            if (original.getWidth() > maxDimension || original.getHeight() > maxDimension) {
                float scale = Math.min(
                    (float) maxDimension / original.getWidth(),
                    (float) maxDimension / original.getHeight()
                );
                int newW = Math.round(original.getWidth() * scale);
                int newH = Math.round(original.getHeight() * scale);
                resized = Bitmap.createScaledBitmap(original, newW, newH, true);
            }

            ByteArrayOutputStream out = new ByteArrayOutputStream();
            resized.compress(Bitmap.CompressFormat.JPEG, 75, out);
            String base64 = Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP);
            return "data:image/jpeg;base64," + base64;
        } catch (Throwable e) {
            // Throwable (não só Exception) porque decodificar imagem pode
            // gerar OutOfMemoryError em fotos muito grandes — não pode
            // deixar isso derrubar o app, só desistir dessa foto.
            lastImageError = e.getClass().getSimpleName() + (e.getMessage() != null ? ": " + e.getMessage() : "");
            return null;
        }
    }
}
