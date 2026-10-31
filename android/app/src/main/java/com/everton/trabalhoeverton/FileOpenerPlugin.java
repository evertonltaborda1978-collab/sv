package com.everton.trabalhoeverton;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;

import androidx.core.content.FileProvider;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;

// Abre um arquivo (PDF) no aplicativo leitor do celular, em vez de só oferecer
// "enviar". O arquivo precisa estar na pasta de cache do app (onde o app grava
// os arquivos antes de compartilhar).
@CapacitorPlugin(name = "FileOpener")
public class FileOpenerPlugin extends Plugin {

    @PluginMethod
    public void open(PluginCall call) {
        String path = call.getString("path");
        String mimeType = call.getString("mimeType", "application/pdf");
        if (path == null || path.isEmpty()) {
            call.reject("Falta o caminho do arquivo.");
            return;
        }

        try {
            String filePath = Uri.parse(path).getPath();
            if (filePath == null) {
                call.reject("Caminho inválido.");
                return;
            }
            File file = new File(filePath);
            if (!file.exists()) {
                call.reject("Arquivo não encontrado.");
                return;
            }

            Uri uri = FileProvider.getUriForFile(
                getContext(),
                getContext().getPackageName() + ".fileprovider",
                file
            );

            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(uri, mimeType);
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (ActivityNotFoundException e) {
            call.reject("Nenhum aplicativo para abrir PDF foi encontrado neste celular.");
        } catch (Exception e) {
            call.reject("Não foi possível abrir o arquivo: " + e.getMessage());
        }
    }
}
