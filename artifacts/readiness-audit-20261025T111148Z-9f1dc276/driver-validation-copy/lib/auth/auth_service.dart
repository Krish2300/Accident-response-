import 'dart:convert';
import '../api/api_client.dart';
import '../models/auth.dart';

class AuthService {
  final ApiClient _api = ApiClient();

  Future<AuthResponse> login(String email, String password) async {
    final response = await _api.post('/api/auth/login', {
      'email': email,
      'password': password,
    });

    if (response.statusCode == 200 || response.statusCode == 201) {
      final data = jsonDecode(response.body) as Map<String, dynamic>;
      final auth = AuthResponse.fromJson(data);
      await _api.setToken(auth.token);
      return auth;
    } else {
      throw Exception('Login failed: ');
    }
  }

  Future<User?> getCurrentUser() async {
    final response = await _api.get('/api/auth/me');
    if (response.statusCode == 200) {
      final data = jsonDecode(response.body) as Map<String, dynamic>;
      return User.fromJson(data);
    }
    return null;
  }

  Future<bool> isLoggedIn() async {
    final token = await _api.getToken();
    return token != null && token.isNotEmpty;
  }

  Future<void> logout() async {
    await _api.clearToken();
  }
}
