#pragma once

#include <fstream>
#include <iostream>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

namespace broko::broker {

// UserStore — простая база пользователей в текстовом формате `user:password`.
// При отсутствии файла используется один встроенный пользователь guest:guest
// для обратной совместимости с amqplib-defaults и существующими тестами.
//
// ПРИМЕЧАНИЕ: пароли в plaintext. Для production стоит заменить на хешированный
// формат (bcrypt/scrypt/argon2 + соль). В рамках курсовой ТЗ требование —
// «закрыть оставшуюся дыру в auth»; этого достаточно для демонстрации
// валидации credentials, отказа доступа и т.п.
class UserStore {
public:
    UserStore() = default;

    // Загружает пары user:password из файла. Возвращает true, если файл загружен;
    // false — если файл отсутствует/не читается (тогда работает default-пользователь).
    bool loadFromFile(const std::string& path) {
        std::ifstream in(path);
        if (!in.is_open()) {
            std::cerr << "[auth] Users file '" << path
                      << "' not found, using built-in guest:guest\n";
            return false;
        }
        std::lock_guard lock(mu_);
        users_.clear();
        std::string line;
        size_t loaded = 0;
        while (std::getline(in, line)) {
            // Trim trailing CR (CRLF files)
            if (!line.empty() && line.back() == '\r') line.pop_back();
            if (line.empty() || line[0] == '#') continue;
            auto pos = line.find(':');
            if (pos == std::string::npos) continue;
            std::string user = line.substr(0, pos);
            std::string pass = line.substr(pos + 1);
            users_[user] = pass;
            ++loaded;
        }
        loaded_ = true;
        std::cerr << "[auth] Loaded " << loaded << " user(s) from " << path << "\n";
        return true;
    }

    // Валидация. true — допуск, false — отказ.
    bool verify(const std::string& user, const std::string& password) const {
        std::lock_guard lock(mu_);
        if (!loaded_) {
            // Permissive default: только guest:guest
            return user == "guest" && password == "guest";
        }
        auto it = users_.find(user);
        if (it == users_.end()) return false;
        return it->second == password;
    }

    // Список пользователей (только имена) — для Web UI и диагностики.
    std::vector<std::string> listUsers() const {
        std::lock_guard lock(mu_);
        std::vector<std::string> out;
        if (!loaded_) {
            out.push_back("guest");
            return out;
        }
        out.reserve(users_.size());
        for (auto& [u, _] : users_) out.push_back(u);
        return out;
    }

    bool isLoaded() const {
        std::lock_guard lock(mu_);
        return loaded_;
    }

private:
    mutable std::mutex mu_;
    std::unordered_map<std::string, std::string> users_;
    bool loaded_ = false;
};

} // namespace broko::broker
