class User {
  final String userId;
  final String email;
  final String role;

  User({required this.userId, required this.email, required this.role});

  factory User.fromJson(Map<String, dynamic> json) {
    return User(
      userId: json['userId'].toString(),
      email: json['email'].toString(),
      role: json['role'].toString(),
    );
  }
}

class AuthResponse {
  final String token;
  final User user;

  AuthResponse({required this.token, required this.user});

  factory AuthResponse.fromJson(Map<String, dynamic> json) {
    return AuthResponse(
      token: json['token'].toString(),
      user: User.fromJson(json['user'] as Map<String, dynamic>),
    );
  }
}
